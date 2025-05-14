import * as frame from '@farcaster/frame-sdk';
import { createWalletClient, http, encodeFunctionData, formatEther, parseEther, zeroAddress, custom, decodeFunctionResult, createPublicClient } from 'viem';
import { base } from 'viem/chains';

// --- Constants ---
const CONTRACT_ADDRESS = '0xB1e0d6ADdc6562bc9d8F7014374DA79535495Ff9'; // Updated contract address
const TOKEN_ID = 1; // From CONTRACT_INTEGRATION.md
const MIDDLEWARE_URL = 'https://auction-api.kasra.codes';

// Flags for manual override are removed as the auction is permanently over.

// --- DOM Elements ---
const nextValidBidEl = document.getElementById('next-valid-bid');
const timeLeftEl = document.getElementById('time-left');
const auctionItemImageEl = document.getElementById('auction-item-image');

let bidAmountInput = document.getElementById('bid-amount');
let placeBidButton = document.getElementById('place-bid-button');
let bidStatusEl = document.getElementById('bid-status');

// Detailed Stats Elements
const highestBidActualEl = document.getElementById('highest-bid-actual');
const highestBidderFidEl = document.getElementById('highest-bidder-fid');
const firstBidderFidEl = document.getElementById('first-bidder-fid');
const firstBidderBadgeEl = document.getElementById('first-bidder-badge');
const userBidCountEl = document.getElementById('user-bid-count'); // In detailed stats
const totalBidsEl = document.getElementById('total-bids');

// --- Global State ---
let viemClient;
let ethProvider;
let publicClient;
let currentUser = { fid: null, account: null };
let auctionEndTime = 0;
let countdownInterval;
let ethUsdPrice = 0; // Add ETH price state
let contractState = {
    reservePrice: BigInt(0),
    minIncrementBps: BigInt(0),
    highestBid: BigInt(0),
    highestBidder: zeroAddress, // Store address for internal logic if needed
    highestBidderFID: BigInt(0), // Added to store FID of highest bidder from render data
    hasFirstBid: false,
    totalBids: BigInt(0)
};

// --- Contract ABIs (simplified from docs) ---
const auctionAbi = [
    { name: 'placeBid', type: 'function', stateMutability: 'payable', inputs: [{ name: 'fid', type: 'uint64' }], outputs: [] },
    { name: 'getAuctionInfo', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: 'highestBidder_', type: 'address' }, { name: 'highestBid_', type: 'uint256' }, { name: 'timeLeft_', type: 'uint256' }] },
    { name: 'getBidderStats', type: 'function', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: 'count', type: 'uint256' }, { name: 'fid', type: 'uint64' }] },
    { name: 'firstBidder', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { name: 'firstBidderFID', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
    { name: 'endTime', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { name: 'tokenURI', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
    // Added for next valid bid calculation and total bids
    { name: 'reservePrice', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { name: 'minIncrementBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { name: 'hasFirstBid', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
    { name: 'totalBids', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    {
        name: 'getAuctionRenderData',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: '_tokenId', type: 'uint256' }],
        outputs: [
            { type: 'uint256', name: 'reservePriceOut' },
            { type: 'uint256', name: 'minIncrementBpsOut' },
            { type: 'uint256', name: 'endTimeOut' },
            { type: 'address', name: 'highestBidderAddressOut' },
            { type: 'uint256', name: 'highestBidOut' },
            { type: 'bool',    name: 'hasFirstBidOut' },
            { type: 'uint64',  name: 'firstBidderFIDOut' },
            { type: 'uint256', name: 'totalBidsOut' },
            { type: 'string',  name: 'tokenURIDataOut' },
            { type: 'uint64',  name: 'fidOfHighestBidderOut' }
        ]
    }
];

// Add this at the very top of the file, after imports
console.log('Script starting - DOM ready state:', document.readyState);

// --- Initialization ---
async function init() {
    console.log("Initializing Win My Time - NFT Auction Frame (Auction OVER state)...");

    // Get fresh references to DOM elements early
    bidAmountInput = document.getElementById('bid-amount');
    placeBidButton = document.getElementById('place-bid-button');
    bidStatusEl = document.getElementById('bid-status');
    // other DOM elements like timeLeftEl, nextValidBidEl, etc., are referenced in setAuctionEndedUI

    try {
        await fetchEthPrice(); // Still useful for displaying bid amounts in USD if needed for final stats

        // Create a public client for read operations, connecting directly to a Base RPC
        // This is needed to fetch the final auction state.
        publicClient = createPublicClient({
            chain: base,
            transport: http() 
        });

        if (publicClient) {
            await fetchAuctionRenderData(); // Fetch latest data to get winner FID etc.
        } else {
            console.warn("Public client could not be created. Final auction data might be unavailable.");
        }
        
        // Attempt to get Farcaster context for user FID if available (for user stats, less critical now)
        try {
            const context = await frame.sdk.context;
            if (context && context.user) {
                let user = context.user;
                if (user && user.user) user = user.user;
                currentUser.fid = user.fid;
                console.log("User FID (for stats):", currentUser.fid);

                // If we have a user, try to get their account for stats
                ethProvider = frame.sdk.wallet.ethProvider;
                if (ethProvider) {
                    const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
                    if (accounts && accounts.length > 0) {
                        currentUser.account = accounts[0];
                        // We don't need to switch network if auction is over and not placing bids
                        await fetchUserStats(); // Fetch user-specific stats if they are connected
                    }
                }
            }
        } catch (fcError) {
            console.warn("Could not get Farcaster context or user data:", fcError);
        }


        setAuctionEndedUI(); // Set the UI to the permanent "Auction Ended" state

        frame.sdk.actions.ready();
        console.log("Win My Time - NFT Auction Frame is ready (Auction OVER state).");

    } catch (error) {
        console.error("Initialization error (Auction OVER state):", error);
        // Fallback UI for error state
        if (timeLeftEl) timeLeftEl.textContent = "Error";
        if (bidStatusEl) bidStatusEl.textContent = "Error loading auction information.";
        if (bidAmountInput) bidAmountInput.disabled = true;
        if (placeBidButton) placeBidButton.textContent = 'Error';
        try { frame.sdk.actions.ready(); } catch (e) { /* ignore */ }
    }
}

// --- UI Update & Interaction Functions (Simplified for Auction OVER state) ---
function calculateNextValidBid() {
    // Not relevant as auction is over.
    return BigInt(0);
}

function updatePrimaryDisplay() {
    // This function might still be called by fetchAuctionRenderData
    // Ensure it reflects the ended state or does nothing harmful.
    if (highestBidActualEl) highestBidActualEl.textContent = formatPriceWithUsd(contractState.highestBid);
    // nextValidBidEl is handled by setAuctionEndedUI
}

function updateCountdown() {
    // Auction is over, no countdown needed.
    if (timeLeftEl) timeLeftEl.textContent = "Bidding is complete!";
    if(countdownInterval) clearInterval(countdownInterval);
}

// --- Contract Read Functions ---
async function fetchAuctionRenderData() {
    console.log("Fetching auction render data...");
    if (!publicClient) {
        console.warn("Public client not available for fetchAuctionRenderData");
        // Update UI to indicate error
        if (nextValidBidEl) nextValidBidEl.textContent = "RPC Error";
        if (timeLeftEl) timeLeftEl.textContent = "RPC Error";
        if (auctionItemImageEl) auctionItemImageEl.alt = "Error loading image data";
        return;
    }

    try {
        const data = await publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: auctionAbi,
            functionName: 'getAuctionRenderData',
            args: [BigInt(TOKEN_ID)]
        });

        // Destructure the returned data array based on the ABI outputs order
        const [
            reservePriceOut,
            minIncrementBpsOut,
            endTimeOut,
            highestBidderAddressOut,
            highestBidOut,
            hasFirstBidOut,
            firstBidderFIDOut,
            totalBidsOut,
            tokenURIDataOut,
            fidOfHighestBidderOut
        ] = data;

        // Update contractState
        contractState.reservePrice = reservePriceOut;
        contractState.minIncrementBps = minIncrementBpsOut;
        contractState.highestBid = highestBidOut;
        contractState.highestBidder = highestBidderAddressOut; // Storing the address
        contractState.highestBidderFID = fidOfHighestBidderOut; // Store FID
        contractState.hasFirstBid = hasFirstBidOut;
        contractState.totalBids = totalBidsOut;

        // Update auction end time and countdown
        auctionEndTime = Number(endTimeOut);
        if (countdownInterval) clearInterval(countdownInterval);
        updateCountdown(); 
        countdownInterval = setInterval(updateCountdown, 1000);

        // Update UI elements
        if (highestBidderFidEl) highestBidderFidEl.textContent = fidOfHighestBidderOut > 0 ? fidOfHighestBidderOut.toString() : 'N/A';
        
        if (firstBidderFidEl) {
            if (contractState.hasFirstBid && firstBidderFIDOut > 0) {
                firstBidderFidEl.textContent = firstBidderFIDOut.toString();
            } else {
                firstBidderFidEl.textContent = 'N/A';
            }
        }
        
        if(totalBidsEl) totalBidsEl.textContent = contractState.totalBids.toString();

        // Process and update token metadata (image)
        if (auctionItemImageEl && tokenURIDataOut) {
            if (tokenURIDataOut.startsWith('data:application/json;base64,')) {
                const metadata = JSON.parse(atob(tokenURIDataOut.substring('data:application/json;base64,'.length)));
                if (metadata.image) {
                    auctionItemImageEl.src = metadata.image;
                } else {
                     console.warn("Token metadata missing image URL.");
                }
            } else if (tokenURIDataOut.startsWith('http')) { // Assuming direct image URL if not base64 json
                 auctionItemImageEl.src = tokenURIDataOut;
            } else {
                console.warn("Token URI is not in expected base64 JSON or direct HTTPS format.");
            }
        } else if (auctionItemImageEl) {
            console.warn("Token URI data not found in getAuctionRenderData response.");
            auctionItemImageEl.alt = "Image not available";
        }

        updatePrimaryDisplay(); // Update price, bid input, and highest bid display

        console.log("Auction render data processed successfully.");

    } catch (error) {
        console.error("Error fetching auction render data:", error);
        if (nextValidBidEl) nextValidBidEl.textContent = "Error";
        if (timeLeftEl) timeLeftEl.textContent = "Error";
        if (auctionItemImageEl && auctionItemImageEl.alt) auctionItemImageEl.alt = "Error loading image data";
    }
}

async function fetchUserStats() {
    if (!publicClient) {
        console.warn("Public client not available for fetchUserStats.");
        if (userBidCountEl) userBidCountEl.textContent = "RPC Error";
        return;
    }
    if (!currentUser.account) {
        if (userBidCountEl) userBidCountEl.textContent = "N/A (Connect Wallet)";
        console.warn("User account not available to identify for fetchUserStats.");
        return;
    }

    console.log(`Fetching stats for user: ${currentUser.account}`);
    try {
        const stats = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'getBidderStats', args: [currentUser.account]
        });
        console.log("User Stats:", stats);
        if (userBidCountEl) userBidCountEl.textContent = stats[0].toString();
    } catch (error) {
        console.error("Error fetching user stats:", error);
        if (userBidCountEl) userBidCountEl.textContent = "Error";
    }
}

// --- Contract Write Functions ---
async function handlePlaceBid() {
    // Auction is permanently over.
    console.log("Bid attempt ignored: Auction has ended.");
    if (bidStatusEl) {
        bidStatusEl.textContent = "Bidding has ended.";
        bidStatusEl.style.color = '#e63946';
    }
}

// Add function to fetch ETH price
async function fetchEthPrice() {
    try {
        const response = await fetch(MIDDLEWARE_URL + '/api/eth-price');
        if (!response.ok) throw new Error('Failed to fetch ETH price');
        const data = await response.json();
        ethUsdPrice = data.price;
        updateAllPriceDisplays();
        updateBidUsdValue(); // Update USD value for current bid input
    } catch (error) {
        console.error('Error fetching ETH price:', error);
    }
}

// Add function to format price with USD
function formatPriceWithUsd(ethAmount) {
    const ethFormatted = formatEther(ethAmount);
    // Only show USD if ETH amount is greater than 0
    if (parseFloat(ethFormatted) === 0) {
        return `${ethFormatted} ETH`;
    }
    const usdValue = parseFloat(ethUsdPrice) * parseFloat(ethFormatted);
    return `${ethFormatted} ETH (≈$${usdValue.toFixed(2)})`;
}

// Add function to update all price displays
function updateAllPriceDisplays() {
    updatePrimaryDisplay();
}

// Update the HTML structure in the bid action area
function updateBidActionArea() {
    // Auction is permanently over. Elements are configured by setAuctionEndedUI.
    if (bidAmountInput) {
        bidAmountInput.disabled = true;
        bidAmountInput.placeholder = 'Auction has ended';
    }
    if (placeBidButton) {
        placeBidButton.textContent = 'Auction Over';
    }
    const bidUsdValue = document.getElementById('bid-usd-value');
    if (bidUsdValue) bidUsdValue.textContent = ''; // Clear USD value next to input
}

// Update the updateBidUsdValue function to be more robust
function updateBidUsdValue() {
    const bidAmountInput = document.getElementById('bid-amount');
    const bidUsdValue = document.getElementById('bid-usd-value');
    if (!bidAmountInput || !bidUsdValue) return;

    const ethAmount = parseFloat(bidAmountInput.value) || 0;
    const usdValue = ethAmount * parseFloat(ethUsdPrice);
    bidUsdValue.textContent = usdValue > 0 ? `≈$${usdValue.toFixed(2)}` : '';
}

// --- Start the app ---
document.addEventListener('DOMContentLoaded', init); 

// --- Renamed function for "Bidding Complete" state, now permanent ---
function setAuctionEndedUI() {
    console.log("Setting UI to permanent 'Auction Ended' state.");
    if (timeLeftEl) timeLeftEl.textContent = "Bidding is complete!";
    
    if (bidAmountInput) {
        bidAmountInput.disabled = true;
        bidAmountInput.value = ''; // Clear any value
        bidAmountInput.placeholder = 'Auction has ended';
    }
    if (placeBidButton) {
        placeBidButton.textContent = 'Auction Over';
        // No need to manage placeBidButton.onclick here if handlePlaceBid prevents action
    }
    
    // Use contractState.highestBidderFID which should be populated by fetchAuctionRenderData
    const winnerFidToDisplay = contractState.highestBidderFID && contractState.highestBidderFID > 0 
                             ? contractState.highestBidderFID.toString() 
                             : "the winner";
    
    let congratsMessage = `Bidding is complete! Congrats to FID ${winnerFidToDisplay}, can\'t wait to see what ideas you\'re thinking!`;

    if (contractState.highestBid === BigInt(0)) {
        congratsMessage = "Bidding is complete! No bids were placed.";
    } else if (winnerFidToDisplay === "the winner" && (!contractState.highestBidderFID || contractState.highestBidderFID === BigInt(0))) {
        // This case means there was a highest bid, but FID is not available/zero.
        congratsMessage = "Bidding is complete! Congrats to the winner! (FID not available)";
    }


    if (bidStatusEl) {
        bidStatusEl.textContent = congratsMessage;
        bidStatusEl.style.color = '#00ffff'; 
    }

    if (nextValidBidEl) {
        nextValidBidEl.textContent = "Auction Ended";
    }

    const bidUsdValue = document.getElementById('bid-usd-value');
    if (bidUsdValue) bidUsdValue.textContent = '';


    if (countdownInterval) clearInterval(countdownInterval);
    
    // Ensure detailed stats are still updated if possible
    if (highestBidActualEl) highestBidActualEl.textContent = formatPriceWithUsd(contractState.highestBid);
    if (highestBidderFidEl) highestBidderFidEl.textContent = contractState.highestBidderFID > 0 ? contractState.highestBidderFID.toString() : 'N/A';
    // firstBidderFidEl is part of fetchAuctionRenderData and its logic can remain
    if(totalBidsEl) totalBidsEl.textContent = contractState.totalBids > 0 ? contractState.totalBids.toString() : '0';
} 