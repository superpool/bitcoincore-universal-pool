var fs = require('fs');
var request = require('request');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');

module.exports = function (logger) {

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function (coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin);
    });

    async.filter(enabledPools, function (coin, callback) {
        SetupForPool(logger, poolConfigs[coin], function (setupResults) {
            callback(null, setupResults);
        });
    }, function (err, results) {
        results.forEach(function (coin) {

            var poolOptions = poolConfigs[coin];
            var processingConfig = poolOptions.paymentProcessing;
            var logSystem = 'Payments';
            var logComponent = coin;

            logger.debug(logSystem, logComponent, 'Payment processing setup with daemon ('
                + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
                + ') and redis (' + poolOptions.redis.host + ':' + poolOptions.redis.port + ')');
        });
    });
};

function SetupForPool(logger, poolOptions, setupFinished) {
    var coin = poolOptions.coin.name;
    var processingConfig = poolOptions.paymentProcessing;

    var logSystem = 'Payments';
    var logComponent = coin;

    var minConfShield = Math.max((processingConfig.minConf || 10), 1); // Don't allow 0 conf transactions.
    var minConfPayout = Math.max((processingConfig.minConf || 10), 1);
    if (minConfPayout < 3) {
        logger.warning(logSystem, logComponent, logComponent + ' minConf of 3 is recommended.');
    }
    var paymentIntervalSecs = 60;
    var maxBlocksPerPayment = 100;
    var fee = 0;

    logger.debug(logSystem, logComponent, logComponent + ' minConf: ' + minConfShield);
    logger.debug(logSystem, logComponent, logComponent + ' payments txfee reserve: ' + fee);
    logger.debug(logSystem, logComponent, logComponent + ' maxBlocksPerPayment: ' + maxBlocksPerPayment);

    var daemon = new Stratum.daemon.interface([processingConfig.daemon], function (severity, message) {
        logger[severity](logSystem, logComponent, message);
    });
    var redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);
    // redis auth if enabled
    if (poolOptions.redis.password) {
        redisClient.auth(poolOptions.redis.password);
    }

    var magnitude;
    var minPaymentSatoshis;
    var coinPrecision;

    var paymentInterval;

    function validateAddress(callback) {
        daemon.cmd('getaddressinfo', [poolOptions.address], function (result) {
            if (result.error) {
                logger.error(logSystem, logComponent, 'Error with payment processing daemon ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else {
                callback()
            }
        }, true);
    }

    function getBalance(callback) {
        daemon.cmd('getbalance', [], function (result) {
            if (result.error) {
                return callback(true);
            }
            try {
                var d = result.data.split('result":')[1].split(',')[0].split('.')[1];
                magnitude = parseInt('10' + new Array(d.length).join('0'));
                minPaymentSatoshis = parseInt(processingConfig.minimumPayment * magnitude);
                coinPrecision = magnitude.toString().length - 1;
            }
            catch (e) {
                logger.error(logSystem, logComponent, 'Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: ' + result.data);
                return callback(true);
            }
            callback();
        }, true, true);
    }

    function asyncComplete(err) {
        if (err) {
            setupFinished(false);
            return;
        }
        if (paymentInterval) {
            clearInterval(paymentInterval);
        }
        paymentInterval = setInterval(processPayments, paymentIntervalSecs * 1000);
        //setTimeout(processPayments, 100);
        setupFinished(true);
    }

    async.parallel([validateAddress,  getBalance], asyncComplete);

    function cacheNetworkStats() {
        var params = null;
        daemon.cmd('getmininginfo', params,
            function (result) {
                if (!result || result.error || result[0].error || !result[0].response) {
                    logger.error(logSystem, logComponent, 'Error with RPC call getmininginfo ' + JSON.stringify(result[0].error));
                    return;
                }

                var coin = logComponent;
                var finalRedisCommands = [];
                if (result[0].response.blocks !== null) {
                    finalRedisCommands.push(['hset', coin + ':network', 'height', result[0].response.blocks]);
                }
                if (result[0].response.difficulty !== null) {
                    finalRedisCommands.push(['hset', coin + ':network', 'difficulty', result[0].response.difficulty*4294967296]);
                }
                if (result[0].response.networkhashps != null || result[0].response.netmhashps != null) {
                    var hashrate = result[0].response.networkhashps || result[0].response.netmhashps*1000000;
                    if(hashrate != null && hashrate != NaN && hashrate !== null && hashrate !== NaN && hashrate != "NaN") {
                        logger.error(logSystem, logComponent, 'getmininginfo ' + hashrate);
                        finalRedisCommands.push(['hset', coin + ':network', 'hashrate', result[0].response.networkhashps || result[0].response.netmhashps * 1000000]);
                    }
                }
                finalRedisCommands.push(['hset', coin + ':network', 'heartbeat', Math.round(Date.now()/1000)]);
                redisClient.multi(finalRedisCommands).exec(function (error, results) {
                    if (error) {
                        logger.error(logSystem, logComponent, 'Error with redis during call to cacheNetworkStats() ' + JSON.stringify(error));
                        return;
                    }
                });

            }
        );
    }

    setInterval(function () {
        // update network stats using coin daemon
        cacheNetworkStats();
    }, 58 * 1000);


    function roundTo(n, digits) {
        if (digits === undefined) {
            digits = 0;
        }
        var multiplicator = Math.pow(10, digits);
        n = parseFloat((n * multiplicator).toFixed(11));
        var test = (Math.round(n) / multiplicator);
        return +(test.toFixed(digits));
    }

    var satoshisToCoins = function (satoshis) {
        return roundTo((satoshis / magnitude), coinPrecision);
    };

    var coinsToSatoshies = function (coins) {
        return Math.round(coins * magnitude);
    };

    var getProperAddress = function (address) {
        if (address.length >= 40) {
            logger.warning(logSystem, logComponent, 'Invalid address ' + address + ', convert to address ' + (poolOptions.invalidAddress || poolOptions.address));
            return (poolOptions.invalidAddress || poolOptions.address);
        }
        if (address.length <= 30) {
            logger.warning(logSystem, logComponent, 'Invalid address ' + address + ', convert to address ' + (poolOptions.invalidAddress || poolOptions.address));
            return (poolOptions.invalidAddress || poolOptions.address);
        }
        return address;
    };

    function coinsRound(number) {
        return roundTo(number, coinPrecision);
    }

    function checkForDuplicateBlockHeight(rounds, height) {
        var count = 0;
        for (var i = 0; i < rounds.length; i++) {
            if (rounds[i].height == height)
                count++;
        }
        return count > 1;
    }

    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function () {
        async.waterfall([
            function (callback) {
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocks:candidate']
                ]).exec(function (error, results) {
                    if (error) {
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }
                    // build workers object from :balances
                    var workers = {};
                    for (var w in results[0]) {
                        workers[w] = {balance: coinsToSatoshies(parseFloat(results[0][w]))};
                    }
                    // build rounds object from :blocksPending
                    var rounds = results[1].map(function (r) {
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            minedby: details[3],
                            time: details[4],
                            duplicate: false,
                            serialized: r
                        };
                    });
                    /* sort rounds by block hieght to pay in order */
                    rounds.sort(function (a, b) {
                        return a.height - b.height;
                    });
                    // find duplicate blocks by height
                    // this can happen when two or more solutions are submitted at the same block height
                    var duplicateFound = false;
                    for (var i = 0; i < rounds.length; i++) {
                        if (checkForDuplicateBlockHeight(rounds, rounds[i].height) === true) {
                            rounds[i].duplicate = true;
                            duplicateFound = true;
                        }
                    }
                    // handle duplicates if needed
                    if (duplicateFound) {
                        var dups = rounds.filter(function (round) {
                            return round.duplicate;
                        });
                        logger.warning(logSystem, logComponent, 'Duplicate pending blocks found: ' + JSON.stringify(dups));
                        // attempt to find the invalid duplicates
                        var rpcDupCheck = dups.map(function (r) {
                            return ['getblock', [r.blockHash]];
                        });
                        daemon.batchCmd(rpcDupCheck, function (error, blocks) {
                            if (error || !blocks) {
                                logger.error(logSystem, logComponent, 'Error with duplicate block check rpc call getblock ' + JSON.stringify(error));
                                return;
                            }
                            // look for the invalid duplicate block
                            var validBlocks = {}; // hashtable for unique look up
                            var invalidBlocks = []; // array for redis work
                            blocks.forEach(function (block, i) {
                                if (block && block.result) {
                                    // invalid duplicate submit blocks have negative confirmations
                                    if (block.result.confirmations < 0) {
                                        logger.warning(logSystem, logComponent, 'Remove invalid duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                        // move from blocksPending to blocksDuplicate...
                                        invalidBlocks.push(['smove', coin + ':blocks:candidate', coin + ':blocks:duplicate', dups[i].serialized]);
                                    } else {
                                        // block must be valid, make sure it is unique
                                        if (validBlocks.hasOwnProperty(dups[i].blockHash)) {
                                            // not unique duplicate block
                                            logger.warning(logSystem, logComponent, 'Remove non-unique duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                            // move from blocksPending to blocksDuplicate...
                                            invalidBlocks.push(['smove', coin + ':blocks:candidate', coin + ':blocks:duplicate', dups[i].serialized]);
                                        } else {
                                            // keep unique valid block
                                            validBlocks[dups[i].blockHash] = dups[i].serialized;
                                            logger.debug(logSystem, logComponent, 'Keep valid duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                        }
                                    }
                                }
                            });
                            // filter out all duplicates to prevent double payments
                            rounds = rounds.filter(function (round) {
                                return !round.duplicate;
                            });
                            // if we detected the invalid duplicates, move them
                            if (invalidBlocks.length > 0) {
                                // move invalid duplicate blocks in redis
                                redisClient.multi(invalidBlocks).exec(function (error, kicked) {
                                    if (error) {
                                        logger.error(logSystem, logComponent, 'Error could not move invalid duplicate blocks in redis ' + JSON.stringify(error));
                                    }
                                    // continue payments normally
                                    callback(null, workers, rounds);
                                });
                            } else {
                                // notify pool owner that we are unable to find the invalid duplicate blocks, manual intervention required...
                                logger.error(logSystem, logComponent, 'Unable to detect invalid duplicate blocks, duplicate block payments on hold.');
                                // continue payments normally
                                callback(null, workers, rounds);
                            }
                        });
                    } else {
                        // no duplicates, continue payments normally
                        callback(null, workers, rounds);
                    }
                });
            },
            function (workers, rounds, callback) {
                // get pending block tx details
                var batchRPCcommand = rounds.map(function (r) {
                    return ['gettransaction', [r.txHash]];
                });
                // get account address (not implemented at this time)
                batchRPCcommand.push(['getaccount', [poolOptions.address]]);
                daemon.batchCmd(batchRPCcommand, function (error, txDetails) {
                    if (error || !txDetails) {
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }

                    var addressAccount = "";
                    // check for transaction errors and generated coins
                    txDetails.forEach(function (tx, i) {
                        if (i === txDetails.length - 1) {
                            if (tx.result && tx.result.toString().length > 0) {
                                addressAccount = tx.result.toString();
                            }
                            return;
                        }
                        var round = rounds[i];
                        // update confirmations for round
                        round.confirmations = tx.result ? parseInt((tx.result.confirmations || 0)) : 0;
                        // look for transaction errors
                        if (tx.error && tx.error.code === -5) {
                            logger.warning(logSystem, logComponent, 'Daemon reports invalid transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)) {
                            logger.warning(logSystem, logComponent, 'Daemon reports no details for transaction: ' + round.txHash);
                            round.category = 'kicked';
                            return;
                        }
                        else if (tx.error || !tx.result) {
                            logger.error(logSystem, logComponent, 'Odd error with gettransaction ' + round.txHash + ' ' + JSON.stringify(tx));
                            return;
                        }
                        // get the coin base generation tx
                        var generationTx = tx.result.details.filter(function (tx) {
                            return tx.address === poolOptions.address;
                        })[0];
                        if (!generationTx && tx.result.details.length === 1) {
                            generationTx = tx.result.details[0];
                        }
                        if (!generationTx) {
                            logger.error(logSystem, logComponent, 'Missing output details to pool address for transaction ' + round.txHash);
                            return;
                        }
                        // get transaction category for round
                        round.category = generationTx.category;
                        // get reward for newly generated blocks
                        if (round.category === 'generate' || round.category === 'immature') {
                            round.reward = coinsRound(parseFloat(generationTx.amount || generationTx.value));
                        }
                    });

                    var canDeleteShares = function (r) {
                        for (var i = 0; i < rounds.length; i++) {
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)) {
                                return false;
                            }
                        }
                        return true;
                    };

                    // continue to next step in waterfall
                    callback(null, workers, rounds);
                });
            },
            function (workers, rounds) {

                var immatureUpdateCommands = [];
                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

                var confirmsUpdate = [];
                var confirmsToDelete = [];

                var moveSharesToCurrent = function (r) {
                    var workerShares = r.workerShares;
                    if (workerShares != null) {
                        logger.warning(logSystem, logComponent, 'Moving shares from orphaned block ' + r.height + ' to current round.');
                        Object.keys(workerShares).forEach(function (worker) {
                            orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent', worker, workerShares[worker]]);
                        });
                    }
                };

                rounds.forEach(function (r) {
                    switch (r.category) {
                        case 'kicked':
                        case 'orphan':
                            confirmsToDelete.push(['hdel', coin + ':blocks:immature', r.blockHash]);
                            movePendingCommands.push(['smove', coin + ':blocks:candidate', coin + ':blocks:kicked', r.serialized]);


                            if (r.canDeleteShares) {
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                                roundsToDelete.push(coin + ':shares:times' + r.height);
                            }
							break;
                        case 'immature':
                            confirmsUpdate.push(['hset', coin + ':blocks:immature', r.blockHash, (r.confirmations || 0)]);
							break;
                        case 'generate':
                            confirmsToDelete.push(['hdel', coin + ':blocks:immature', r.blockHash]);
                            movePendingCommands.push(['smove', coin + ':blocks:candidate', coin + ':blocks:mature', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            roundsToDelete.push(coin + ':shares:times' + r.height);

                            r.category = 'mature';
                            break;
                    }
                    //coin:block:state:hash:height:difficulty:confirmations:reward:time
                    var poolEvents = [
                        coin,
                        'block',
                        r.category,
                        r.blockHash,
                        r.height,
                        1,
                        r.confirmations || 0,
                        coinsToSatoshies(r.reward) || 0
                    ].join(':');
                    logger.warning(logSystem, logComponent, poolEvents);
                    redisClient.publish('pool:events', poolEvents);
                    redisClient.zadd('pool:events',Math.floor(Date.now() /1000),poolEvents);

                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (immatureUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(immatureUpdateCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                if (confirmsUpdate.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(confirmsUpdate);

                if (confirmsToDelete.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(confirmsToDelete);

                if (finalRedisCommands.length === 0){
                    return;
                }
                redisClient.multi(finalRedisCommands).exec(function(error, results){
                    if (error) {
                        clearInterval(paymentInterval);

                        logger.error(logSystem, logComponent,
                            'Payments sent but could not update redis. ' + JSON.stringify(error)
                            + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                            + coin + '_finalRedisCommands.txt must be ran manually');

                        fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function(err){
                            logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                        });
                    }
                });
            }
        ], function () {
            logger.debug(logSystem, logComponent, 'Finished interval');
        });
    };
}
