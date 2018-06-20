var Stratum = require('stratum-pool');
var redis = require('redis');
var net = require('net');

var ShareProcessor = require('./shareProcessor.js');

module.exports = function (logger) {

    var _this = this;

    var poolConfigs = JSON.parse(process.env.pools);
    var portalConfig = JSON.parse(process.env.portalConfig);

    var forkId = process.env.forkId;

    var pools = {};

    var redisClient = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
    if (portalConfig.redis.password) {
        redisClient.auth(portalConfig.redis.password);
    }

    Object.keys(poolConfigs).forEach(function (coin) {
        var poolOptions = poolConfigs[coin];

        var logSystem = 'Pool';
        var logComponent = coin;
        var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

        var handlers = {
            auth: function () {
            },
            share: function () {
            },
            diff: function () {
            }
        };
        var shareProcessor = new ShareProcessor(logger, poolOptions);

        handlers.auth = function (port, workerName, password, authCallback) {
            if (poolOptions.validateWorkerUsername !== true)
                authCallback(true);
            else {
                pool.daemon.cmd('validateaddress', [String(workerName).split(".")[0]], function (results) {
                    var isValid = results.filter(function (r) {
                        return r.response.isvalid
                    }).length > 0;
                    authCallback(isValid);
                });
            }
        };

        handlers.share = function (isValidShare, isValidBlock, data) {
            shareProcessor.handleShare(isValidShare, isValidBlock, data);
        };

        var authorizeFN = function (ip, port, workerName, password, callback) {
            handlers.auth(port, workerName, password, function (authorized) {
                var authString = authorized ? 'Authorized' : 'Unauthorized ';
                logger.debug(logSystem, logComponent, logSubCat, authString + ' ' + workerName + ':' + password + ' [' + ip + ']');
                callback({
                    error: null,
                    authorized: authorized,
                    disconnect: false
                });
            });
        };

        var pool = Stratum.createPool(poolOptions, authorizeFN, logger);

        pool.on('share', function (isValidShare, isValidBlock, data) {

            var shareData = JSON.stringify(data);
            logger.debug(logSystem, logComponent, logSubCat, 'Share data: ' + shareData);
            if (data.blockHash && !isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'We thought a block was found but it was rejected by the daemon, share data: ' + shareData);

            else if (isValidBlock)
                logger.debug(logSystem, logComponent, logSubCat, 'Block found: ' + data.blockHash + ' by ' + data.worker);

            if (isValidShare) {
                if (data.shareDiff > 1000000000) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Share was found with diff higher than 1.000.000.000!');
                } else if (data.shareDiff > 1000000) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Share was found with diff higher than 1.000.000!');
                }
            } else if (!isValidShare) {
                logger.debug(logSystem, logComponent, logSubCat, 'Share rejected: ' + shareData);
            }

            // handle the share
            handlers.share(isValidShare, isValidBlock, data);
        }).on('difficultyUpdate', function (workerName, diff) {
            logger.debug(logSystem, logComponent, logSubCat, 'Difficulty update to diff ' + diff + ' workerName=' + JSON.stringify(workerName));
            handlers.diff(workerName, diff);
        }).on('log', function (severity, text) {
            logger[severity](logSystem, logComponent, logSubCat, text);
        }).on('banIP', function (ip, worker) {
            process.send({type: 'banIP', ip: ip});
        }).on('started', function () {
            _this.setDifficultyForProxyPort(pool, poolOptions.coin.name, poolOptions.coin.algorithm);
        });

        pool.start();
        pools[poolOptions.coin.name] = pool;
    });

    var logSystem = 'Switching';
    var logComponent = 'Setup';
    var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

    this.getFirstPoolForAlgorithm = function (algorithm) {
        var foundCoin = "";
        Object.keys(poolConfigs).forEach(function (coinName) {
            if (poolConfigs[coinName].coin.algorithm == algorithm) {
                if (foundCoin === "")
                    foundCoin = coinName;
            }
        });
        return foundCoin;
    };

    //
    // Called when stratum pool emits its 'started' event to copy the initial diff and vardiff
    // configuation for any proxy switching ports configured into the stratum pool object.
    //
    this.setDifficultyForProxyPort = function (pool, coin, algo) {

        logger.debug(logSystem, logComponent, algo, 'Setting proxy difficulties after pool start');

        Object.keys(portalConfig.switching).forEach(function (switchName) {
            if (!portalConfig.switching[switchName].enabled) return;

            var switchAlgo = portalConfig.switching[switchName].algorithm;
            if (pool.options.coin.algorithm !== switchAlgo) return;

            // we know the switch configuration matches the pool's algo, so setup the diff and
            // vardiff for each of the switch's ports
            for (var port in portalConfig.switching[switchName].ports) {

                if (portalConfig.switching[switchName].ports[port].varDiff)
                    pool.setVarDiff(port, portalConfig.switching[switchName].ports[port].varDiff);

                if (portalConfig.switching[switchName].ports[port].diff) {
                    if (!pool.options.ports.hasOwnProperty(port))
                        pool.options.ports[port] = {};
                    pool.options.ports[port].diff = portalConfig.switching[switchName].ports[port].diff;
                }
            }
        });
    };
};
