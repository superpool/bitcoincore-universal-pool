var redis = require('redis');
var Stratum = require('stratum-pool');

module.exports = function (logger, poolConfig) {

    var redisConfig = poolConfig.redis;
    var coin = poolConfig.coin.name;

    var forkId = process.env.forkId;
    var logSystem = 'Pool';
    var logComponent = coin;
    var logSubCat = 'Thread ' + (parseInt(forkId) + 1);

    var redisClient = redis.createClient(redisConfig.port, redisConfig.host);
    if (redisConfig.password) {
        redisClient.auth(redisConfig.password);
    }
    redisClient.on('ready', function () {
        logger.debug(logSystem, logComponent, logSubCat, 'Share processing setup with redis (' + redisConfig.host +
            ':' + redisConfig.port + ')');
    });
    redisClient.on('error', function (err) {
        logger.error(logSystem, logComponent, logSubCat, 'Redis client had an error: ' + JSON.stringify(err))
    });
    redisClient.on('end', function () {
        logger.error(logSystem, logComponent, logSubCat, 'Connection to redis database has been ended');
    });

    this.handleShare = function (isValidShare, isValidBlock, shareData) {

        var redisCommands = [];
        var poolEvents;
        var dateNow = Date.now();
        var dateNowSeconds = dateNow / 1000;

        var workerId = '';
        var workerIdPos = shareData.worker.indexOf('/');
        if (workerIdPos != -1) {
            workerId = shareData.worker.substr(workerIdPos + 1);
            shareData.worker = shareData.worker.substr(0, workerIdPos);
        }

        redisCommands.push(['hset', coin + ':workers:' + shareData.worker, 'lastShare', Math.round(dateNow / 1000)]);

        if (isValidShare) {
            redisCommands.push(['hincrbyfloat', coin + ':shares:roundCurrent', shareData.worker, shareData.difficulty*4294967296]);
            redisCommands.push(['hincrby', coin + ':stats', 'validShares', 1]);
            redisCommands.push(['hincrbyfloat', coin + ':workers:' + shareData.worker, 'hashes', shareData.difficulty*4294967296]);
            redisCommands.push(['hincrby', coin + ':workers:' + shareData.worker, 'validShares', 1]);
        } else {
            redisCommands.push(['hincrby', coin + ':stats', 'invalidShares', 1]);
            redisCommands.push(['hincrby', coin + ':workers:' + shareData.worker, 'invalidShares', 1]);
        }

        var hashrateData = [isValidShare ? shareData.difficulty : -shareData.difficulty, shareData.worker, dateNow];
        redisCommands.push(['zadd', coin + ':hashrate', dateNow / 1000 | 0, hashrateData.join(':')]);

        if (isValidBlock) {
            redisCommands.push(['rename', coin + ':shares:roundCurrent', coin + ':shares:round' + shareData.height]);
            redisCommands.push(['rename', coin + ':shares:timesCurrent', coin + ':shares:times' + shareData.height]);
            redisCommands.push(['sadd', coin + ':blocks:candidate', [shareData.blockHash, shareData.txHash, shareData.height, shareData.worker, dateNow].join(':')]);
            redisCommands.push(['hincrby', coin + ':stats', 'validBlocks', 1]);
            poolEvents = [
                coin,
                "share",
                shareData.worker,
                workerId,
                1,
                1,
                shareData.difficulty*4294967296,
                shareData.blockHash ? shareData.blockHash : (shareData.blockHashInvalid ? shareData.blockHashInvalid : ''),
                dateNowSeconds
            ].join(':');

            redisClient.publish('pool:events', poolEvents);
            redisClient.zadd('pool:events',Math.floor(Date.now() /1000),poolEvents);

            poolEvents = [
                coin,
                'block',
                'candidate',
                shareData.blockHash,
                shareData.height,
                shareData.blockDiff*4294967296,
                0,
                0
            ].join(':');


            //test
            redisClient.publish('pool:events', poolEvents);
            redisClient.zadd('pool:events',Math.floor(Date.now() /1000),poolEvents);

        } else if (isValidShare) {
            poolEvents = [
                coin,
                "share",
                shareData.worker,
                workerId,
                1,
                0,
                shareData.difficulty*4294967296,
                shareData.blockHash ? shareData.blockHash : (shareData.blockHashInvalid ? shareData.blockHashInvalid : ''),
                dateNowSeconds
            ].join(':');

            redisClient.publish('pool:events', poolEvents);
            redisClient.zadd('pool:events',Math.floor(Date.now() /1000),poolEvents);

            if (shareData.blockHash) {
                redisCommands.push(['hincrby', coin + ':stats', 'invalidBlocks', 1]);
            }
        }

        redisClient.multi(redisCommands).exec(function (error, replies) {
            if (error) {
                logger.error(logSystem, logComponent, logSubCat, 'Error with share processor multi ' + JSON.stringify(error));
            }
        });
    };

};
