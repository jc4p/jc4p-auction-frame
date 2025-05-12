/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npx wrangler dev src/index.js` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npx wrangler publish src/index.js --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const CACHE_DURATION = 5 * 60; // 5 minutes in seconds

const app = new Hono();

// Enable CORS for all routes
app.use('/*', cors({
	origin: ['https://auction.kasra.codes', 'http://localhost:5173'],
	allowMethods: ['GET', 'OPTIONS'],
	allowHeaders: ['Content-Type'],
	exposeHeaders: ['Content-Length'],
	maxAge: 86400,
	credentials: true,
}));

// ETH price endpoint
app.get('/api/eth-price', async (c) => {
	try {
		// Check cache first
		const cachedPrice = await c.env.CACHE.get('eth_price');
		if (cachedPrice) {
			return c.json(JSON.parse(cachedPrice));
		}

		// Fetch from Alchemy if not in cache
		const response = await fetch(
			`https://api.g.alchemy.com/prices/v1/${c.env.ALCHEMY_API_KEY}/tokens/by-symbol?symbols=ETH`
		);

		if (!response.ok) {
			throw new Error(`Alchemy API error: ${response.status}`);
		}

		const data = await response.json();
		
		// Extract USD price
		const ethPrice = data.data[0]?.prices[0]?.value;
		if (!ethPrice) {
			throw new Error('Invalid price data from Alchemy');
		}

		const priceData = { price: ethPrice }; // Keep as string from Alchemy

		// Cache the price
		await c.env.CACHE.put('eth_price', JSON.stringify(priceData), {
			expirationTtl: CACHE_DURATION
		});

		return c.json(priceData);
	} catch (error) {
		return c.json({ error: error.message }, 500);
	}
});

// Health check endpoint
app.get('/health', (c) => c.json({ status: 'ok' }));

export default app;
