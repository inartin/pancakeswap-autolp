# Jupiter WebSocket API Documentation

## Overview

The Jupiter WebSocket API provides real-time streaming data for cryptocurrency assets on the Solana blockchain, including price updates, transaction events, and asset metadata.

**WebSocket URL:** `wss://trench-stream.jup.ag/ws`

## Connection

### Establishing a Connection

Connect to the WebSocket endpoint using standard WebSocket protocols:

```javascript
const ws = new WebSocket('wss://trench-stream.jup.ag/ws', {
  headers: {
    'Origin': 'https://jup.ag',
    'User-Agent': 'Mozilla/5.0 (compatible; YourApp/1.0)'
  }
});
```

### Required Headers

- **Origin:** `https://jup.ag`
- **User-Agent:** Standard browser or application user agent string

## Subscriptions

After establishing a connection, subscribe to data streams by sending JSON-formatted subscription messages. Multiple subscriptions can be active simultaneously.

### Subscribe to Price Updates

Receive real-time price updates for specified assets.

**Request:**
```json
{
  "type": "subscribe:prices",
  "assets": [
    "So11111111111111111111111111111111111111112",
    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
  ]
}
```

**Parameters:**
- `type` (string, required): Must be `"subscribe:prices"`
- `assets` (array, required): Array of Solana token mint addresses

**Response Format:**
```json
{
  "type": "prices",
  "data": [
    {
      "assetId": "So11111111111111111111111111111111111111112",
      "price": 138.2579752788855,
      "blockId": 382347373
    }
  ]
}
```

### Subscribe to Asset Metadata

Receive detailed asset information and statistics updates.

**Request:**
```json
{
  "type": "subscribe:assets",
  "assets": [
    "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"
  ]
}
```

**Parameters:**
- `type` (string, required): Must be `"subscribe:assets"`
- `assets` (array, required): Array of Solana token mint addresses

**Response Format:**
```json
{
  "type": "asset-updates",
  "data": [
    {
      "type": "update",
      "asset": {
        "id": "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk",
        "name": "USELESS COIN",
        "symbol": "USELESS",
        "icon": "https://i.imgur.com/S17YRd3.png",
        "decimals": 6,
        "twitter": "https://x.com/theunipcs/status/1921208257399382410",
        "dev": "ArfVe1K5gt5zsxzRCWSQeWc1rJSJjZzuuYxmvRh71mMQ",
        "circSupply": 999090378.829573,
        "totalSupply": 999090378.829573,
        "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "launchpad": "letsbonk.fun",
        "metaLaunchpad": "raydium-launchlab",
        "partnerConfig": "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1",
        "firstPool": {
          "id": "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk",
          "createdAt": "2025-05-10T14:20:53Z"
        },
        "graduatedPool": "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp",
        "graduatedAt": "2025-05-10T14:23:16Z",
        "holderCount": 38508,
        "audit": {
          "mintAuthorityDisabled": true,
          "freezeAuthorityDisabled": true,
          "topHoldersPercentage": 21.495585278600633,
          "devMigrations": 189
        },
        "organicScore": 96.3643090025775,
        "organicScoreLabel": "high",
        "isVerified": true,
        "tags": [
          "community-assist",
          "launchpad",
          "moonshot-verified",
          "verified"
        ],
        "createdAt": "2025-05-10T14:20:53Z",
        "fdv": 113545511.13290456,
        "mcap": 113545511.13290456,
        "usdPrice": 0.11364888856794145,
        "priceBlockId": 382352053,
        "liquidity": 2511186.659542529,
        "stats5m": {
          "priceChange": -0.5199566313170512,
          "holderChange": -0.023366305787055067,
          "liquidityChange": -0.48973014802574655,
          "volumeChange": 143.97763385839846,
          "buyVolume": 3243.1065510649,
          "sellVolume": 12374.051444342189,
          "buyOrganicVolume": 742.8455766623033,
          "sellOrganicVolume": 1070.8590576360896,
          "numBuys": 91,
          "numSells": 126,
          "numTraders": 48,
          "numOrganicBuyers": 3,
          "numNetBuyers": 6
        },
        "stats1h": {
          "priceChange": -0.515712267605372,
          "holderChange": -0.01038637307852098,
          "liquidityChange": -0.0632113541887591,
          "volumeChange": -30.35389856128453,
          "buyVolume": 101206.82156741654,
          "sellVolume": 124500.86248537854,
          "buyOrganicVolume": 46833.13610007701,
          "sellOrganicVolume": 19135.08300737637,
          "numBuys": 790,
          "numSells": 969,
          "numTraders": 244,
          "numOrganicBuyers": 13,
          "numNetBuyers": 41
        },
        "stats6h": {
          "priceChange": 0.6975371744877639,
          "holderChange": -0.012982629242074103,
          "liquidityChange": 2.2552869758929037,
          "volumeChange": -70.90866486127562,
          "buyVolume": 1411530.3625217546,
          "sellVolume": 1152020.6744950528,
          "buyOrganicVolume": 349400.78668771137,
          "sellOrganicVolume": 141521.5626947423,
          "numBuys": 7305,
          "numSells": 8196,
          "numTraders": 1161,
          "numOrganicBuyers": 44,
          "numNetBuyers": 219
        },
        "stats24h": {
          "priceChange": 20.91050133574387,
          "holderChange": 0.30998463101409257,
          "liquidityChange": 13.649351270768106,
          "volumeChange": 105.62601889620238,
          "buyVolume": 10110593.355085324,
          "sellVolume": 9130698.731720151,
          "buyOrganicVolume": 2159029.8673564177,
          "sellOrganicVolume": 1469773.288201804,
          "numBuys": 50594,
          "numSells": 52159,
          "numTraders": 5081,
          "numOrganicBuyers": 268,
          "numNetBuyers": 1391
        },
        "stats7d": {
          "priceChange": 2.0483630380266815
        },
        "stats30d": {
          "priceChange": -61.124167894403556
        },
        "ctLikes": 49,
        "smartCtLikes": 20,
        "updatedAt": "2025-11-25T05:04:14.748948371Z"
      }
    }
  ]
}
```

### Subscribe to Transaction Events

Receive real-time transaction (buy/sell) events for specified assets.

**Request:**
```json
{
  "type": "subscribe:txns",
  "assets": [
    "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"
  ]
}
```

**Parameters:**
- `type` (string, required): Must be `"subscribe:txns"`
- `assets` (array, required): Array of Solana token mint addresses

**Response Format:**
```json
{
  "type": "actions",
  "data": [
    {
      "timestamp": "2025-11-25T04:34:02.000Z",
      "asset": "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk",
      "type": "buy",
      "usdPrice": 0.11465510337557419,
      "usdVolume": 11.961246442504043,
      "nativeVolume": 0.086633834,
      "traderAddress": "FEkRZpYMcdg7CfmS3uB5S6wR1qAwNXi4DBPNKzQW3aRj",
      "txHash": "5BbLbmhzwnCcBjeAGopr2eEY6fUpg9V1kHAtBReozeZPEWVdrg2hhV7z3e7koruGPtrkhWWjGz43RTyeTEGfWxpY",
      "amount": 104.323716,
      "isMev": false,
      "isValidPrice": true,
      "isValidPosition": true,
      "poolId": "8ztFxjFPfVUtEf4SLSapcFj8GW2dxyUA9no2bLPq7H7V"
    }
  ]
}
```

## Data Structures

### Price Update Object

| Field | Type | Description |
|-------|------|-------------|
| `assetId` | string | Solana token mint address |
| `price` | number | Current price in USD |
| `blockId` | number | Solana block number at time of price update |

### Transaction Action Object

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | string | ISO 8601 timestamp of transaction |
| `asset` | string | Token mint address |
| `type` | string | Transaction type: `"buy"` or `"sell"` |
| `usdPrice` | number | Price per token in USD |
| `usdVolume` | number | Total transaction volume in USD |
| `nativeVolume` | number | Transaction volume in native token |
| `traderAddress` | string | Wallet address of trader |
| `txHash` | string | Solana transaction hash |
| `amount` | number | Number of tokens traded |
| `isMev` | boolean | Whether transaction is MEV-related |
| `isValidPrice` | boolean | Price validation flag |
| `isValidPosition` | boolean | Position validation flag |
| `poolId` | string | Liquidity pool identifier |

### Asset Statistics Object

Statistics are provided for multiple time windows: `stats5m`, `stats1h`, `stats6h`, `stats24h`, `stats7d`, `stats30d`.

| Field | Type | Description |
|-------|------|-------------|
| `priceChange` | number | Price change percentage |
| `holderChange` | number | Change in holder count percentage |
| `liquidityChange` | number | Change in liquidity percentage |
| `volumeChange` | number | Change in volume percentage |
| `buyVolume` | number | Total buy volume in USD |
| `sellVolume` | number | Total sell volume in USD |
| `buyOrganicVolume` | number | Organic (non-MEV) buy volume |
| `sellOrganicVolume` | number | Organic sell volume |
| `numBuys` | number | Number of buy transactions |
| `numSells` | number | Number of sell transactions |
| `numTraders` | number | Unique trader count |
| `numOrganicBuyers` | number | Unique organic buyer count |
| `numNetBuyers` | number | Net buyers (buyers - sellers) |

## Usage Example

```javascript
import WebSocket from 'ws';

const USELESS_TOKEN = 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk';

const ws = new WebSocket('wss://trench-stream.jup.ag/ws', {
  headers: {
    'Origin': 'https://jup.ag',
    'User-Agent': 'Mozilla/5.0 (compatible; MyApp/1.0)'
  }
});

ws.on('open', () => {
  console.log('Connected to Jupiter WebSocket');

  // Subscribe to asset metadata and statistics
  ws.send(JSON.stringify({
    type: 'subscribe:assets',
    assets: [USELESS_TOKEN]
  }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data);

  if (message.type === 'asset-updates') {
    const asset = message.data[0]?.asset;

    if (asset) {
      console.log(`\n${asset.name} (${asset.symbol})`);
      console.log(`Price: $${asset.usdPrice}`);
      console.log(`Market Cap: $${asset.mcap.toLocaleString()}`);
      console.log(`Liquidity: $${asset.liquidity.toLocaleString()}`);
      console.log(`Holders: ${asset.holderCount.toLocaleString()}`);
      console.log(`24h Change: ${asset.stats24h.priceChange.toFixed(2)}%`);
      console.log(`24h Volume: $${(asset.stats24h.buyVolume + asset.stats24h.sellVolume).toLocaleString()}`);
    }
  }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

ws.on('close', () => {
  console.log('Connection closed');
});
```

## Best Practices

1. **Connection Management**: Implement reconnection logic with exponential backoff for production applications
2. **Message Buffering**: Handle high-frequency updates appropriately to avoid overwhelming your application
3. **Resource Cleanup**: Always close WebSocket connections when they're no longer needed
4. **Error Handling**: Implement robust error handling for malformed messages or connection issues
5. **Rate Limiting**: Be mindful of subscription counts and message processing to avoid performance issues

## Common Token Addresses

| Token | Symbol | Address |
|-------|--------|---------|
| Solana | SOL | `So11111111111111111111111111111111111111112` |
| Jupiter | JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |

## Notes

- All prices are denominated in USD
- Block IDs reference Solana blockchain block numbers
- Timestamps are provided in ISO 8601 format (UTC)
- Asset addresses are Solana token mint addresses (base58 encoded)
- The WebSocket maintains persistent connections; there is no explicit unsubscribe mechanism shown in the available data
