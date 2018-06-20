# bitcoincore-universal-pool
Universal mining pool with support 35 hashing algoritms and more 100 coins based on this algoritms.

Supported algoritms
- sha256
- sha256d
- scrypt
- scrypt-og
- scrypt-jane
- scrypt-n
- sha1
- c11
- x11
- x11gost
- bitcore
- x13
- x15
- nist5
- quark
- keccak
- keccakc
- blake
- blake2s
- skein
- groestlmyriad
- groestl
- fugue
- shavite3
- hefty1
- whirlpoolx
- lyra2re
- lyra2re2
- lyra2z
- lyra2h
- tribus
- skunk
- jha
- qubit
- zr5
- ziftr
- hsr
- neoscrypt
- fresh

Features
- Support stratum mining
- Support vardiff, fixediff
- Support workers id
- PPLNS block reward
- JSON API for get statistic
- An easily extendable, responsive, light-weight front-end using API to display data
- IP banning to prevent low-diff share attacks
- Session managing for purging DDoS/flood initiated zombie workers
- Auto ban IPs that are flooding with invalid shares
- Socket flooding detection
- Detailed logging
- Ability to configure multiple ports - each with their own difficulty
- Support Nicehash, MiningRigRentails

JSON API
 API is unified on all our pool's (
 [Ethash pool](https://github.com/superpool/ethash-universal-pool)
 [Bitcoincore pool](https://github.com/superpool/bitcoincore-universal-pool)
 [Equihash pool](https://github.com/superpool/equihash-universal-pool)
 [Cryptonote pool](https://github.com/superpool/cryptonote-universal-pool)
 )
 - /health
 - /stats
 - /live_stats
 - /stats_address
 - /get_payments
 - /get_blocks
 - /get_payment

Unsupported
- P2P
- Blocknotify

Configuration
- Configuration is actually simple, just read it twice and think twice before changing defaults.
- One instance multiply coins
- Dev fee 1.5% of pool fee.

Dependencies:
- Ubuntu 16.04 LTS
- Nginx
- Redis-server
- Nodejs
- Coin daemon (support coins based on bitcoin core v0.13-0.16)

Credits
- Modifed by AME Corp
- Based on node-stratum-pool
