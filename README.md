[![npm][npm-image]][npm-url]
[![npm-downloads][npm-downloads-image]][npm-url]
<br />
[![code-style-prettier][code-style-prettier-image]][code-style-prettier-url]

[code-style-prettier-image]: https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square
[code-style-prettier-url]: https://github.com/prettier/prettier
[npm-downloads-image]: https://img.shields.io/npm/dm/@nftechie/smart-rpc.svg?style=flat
[npm-image]: https://img.shields.io/npm/v/@nftechie/smart-rpc.svg?style=flat
[npm-url]: https://www.npmjs.com/package/@nftechie/smart-rpc

# Solana Smart RPC

Intelligent transport layer for Solana RPCs that handles load balancing, rate limit throttling, failover, fanouts, and retries. Built on top of [@solana/web3.js](https://www.npmjs.com/package/@solana/web3.js).

# Example Usage

```tsx
import { TransportManager, TransportConfig } from '@nftechie/smart-rpc';

let transports: TransportConfig[] = [
    {
        rate_limit: 50,
        weight: 50,
        blacklist: [],
        url: 'https://bold-winter-brook.solana-mainnet.quiknode.pro/039710b0695699c8b2849d5903a9735260339476/',
        enable_smart_disable: false,
        enable_failover: false,
        max_retries: 0,
    },
    {
        rate_limit: 50,
        weight: 50,
        blacklist: ['getTokenLargestAccounts'],
        url: 'https://api.mainnet-beta.solana.com',
        enable_smart_disable: true,
        enable_failover: true,
        max_retries: 0,
    }
];

const transportManager = new TransportManager(transports);
const smartConnection = transportManager.smartConnection;

const resp = await smartConnection.getLatestBlockhash();
console.log(resp.blockhash.toString());
```