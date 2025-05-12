# JC4P NFT Auction Frontend Spec Sheet

This document outlines the full frontend requirements and integration details for the JC4P 1-of-1 NFT auction on Base, including on-chain interaction, auction mechanics, and Farcaster Frame V2 SDK support using `viem` natively for encoding and provider interaction.

---

## ⚙️ Frontend Stack

* **JavaScript**: Vanilla JS with a bundler
* **Library**: [`viem`](https://viem.sh) for ABI encoding, decoding, and contract interactions
* **Frames**: Farcaster Frame V2 SDK (`@farcaster/frame-sdk`)
* **Network**: Base Mainnet (Chain ID: 8453)

---

## 🔐 Contract Details

* **Contract Type**: ERC-721 with embedded English auction logic
* **Contract Address**: `0xA3BcAbb39b280F5878571e6451DBbFcc1c1554B2`
* **Token ID**: `1`

---

## 🖼 Frame Integration Requirements

### Installation

```bash
npm install @farcaster/frame-sdk viem
```

### HTML Meta Tag

```html
<meta name="fc:frame" content='{"version":"next","imageUrl":"https://yourdomain.com/preview.jpg","button":{"title":"Place Bid","action":{"type":"launch_frame","name":"JC4P Auction","url":"https://yourdomain.com","splashImageUrl":"https://yourdomain.com/splash.png","splashBackgroundColor":"#eeeeee"}}}' />
```

### Frame Context

```js
import * as frame from '@farcaster/frame-sdk';

const context = await frame.sdk.context;
let user = context.user;
if (user.user) user = user.user;
```

### Make App Ready

```js
frame.sdk.actions.ready();
```

---

## 🪙 viem + ethProvider Integration

Use `ethProvider` from the Frame SDK for viem's `http()` transport:

```ts
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';

const ethProvider = await frame.sdk.wallet.ethProvider;
const client = createWalletClient({
  chain: base,
  transport: http(ethProvider)
});
```

---

## 💸 Auction Features

### Place Bid

```ts
import { encodeFunctionData } from 'viem';

const data = encodeFunctionData({
  abi: [{
    name: 'placeBid',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{ name: 'fid', type: 'uint64' }],
    outputs: []
  }],
  functionName: 'placeBid',
  args: [user.fid]
});

const tx = await ethProvider.request({
  method: 'eth_sendTransaction',
  params: [{
    from: account,
    to: CONTRACT_ADDRESS,
    data,
    value: '0x' + BigInt(bidAmountETH * 1e18).toString(16)
  }]
});
```

---

## 🧾 Read Contract State with viem

### Get Auction Info

```ts
import { readContract } from 'viem';

const { highestBidder, highestBid, timeLeft } = await client.readContract({
  address: CONTRACT_ADDRESS,
  abi: [{
    name: 'getAuctionInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'highestBidder_', type: 'address' },
      { name: 'highestBid_', type: 'uint256' },
      { name: 'timeLeft_', type: 'uint256' }
    ]
  }],
  functionName: 'getAuctionInfo'
});
```

### Get Bidder Stats

```ts
const { count, fid } = await client.readContract({
  address: CONTRACT_ADDRESS,
  abi: [{
    name: 'getBidderStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [
      { name: 'count', type: 'uint256' },
      { name: 'fid', type: 'uint64' }
    ]
  }],
  functionName: 'getBidderStats',
  args: [account]
});
```

### Get First Bidder Info

```ts
const { firstBidder, firstBidderFID } = await client.readContract({
  address: CONTRACT_ADDRESS,
  abi: [{
    name: 'firstBidder',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  }, {
    name: 'firstBidderFID',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }]
  }]
});
```

### Countdown Timer

```ts
const endTime = await client.readContract({
  address: CONTRACT_ADDRESS,
  abi: [{
    name: 'endTime',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  }],
  functionName: 'endTime'
});

const now = Math.floor(Date.now() / 1000);
const secondsRemaining = Math.max(0, Number(endTime) - now);
```

---

## 📊 Metrics to Display on Frontend

* **Current Highest Bid** (in ETH or formatted wei via `getAuctionInfo()`)
* **Current Highest Bidder** address + FID
* **Countdown Timer** until `endTime`
* **First Bidder** address via `firstBidder()` and FID via `firstBidderFID()`
* **Current User's Bid Count** and FID (from `getBidderStats`)
* **Full Bid Log (optional)**: listen to `BidPlaced` events, decode via `viem`

---

## 🖼 Token Metadata

* Accessible via `tokenURI(1)`
* Returns base64-encoded `data:application/json` string with:

  * `name`
  * `description`
  * `image`
  * `attributes[]`: `Winner FID`, `Winning Bid (wei)` after auction ends

---

## 🧪 Optional Utilities

* `View Profile` via:

```ts
await frame.sdk.actions.viewProfile({ fid: user.fid });
```

* `Cast Intent`:

```ts
const castUrl = `https://warpcast.com/~/compose?text=${encodeURIComponent('I just bid on JC4P’s 1-of-1 NFT')}&embeds[]=${encodeURIComponent(window.location.href)}`;
await frame.sdk.actions.openUrl({ url: castUrl });
```

---

## ✅ Summary Checklist

* [x] Read and display: current bid, highest bidder (w/ FID), time left
* [x] Display first bidder (address + FID)
* [x] Show current user’s bid count and FID
* [x] Allow authenticated Farcaster user to place bids with ETH
* [x] Encode and send tx with viem using `ethProvider`
* [x] Support countdown, bid feedback, and post-auction metadata
* [x] Fully compatible with Farcaster Frame V2
* [x] Use Base Mainnet only

