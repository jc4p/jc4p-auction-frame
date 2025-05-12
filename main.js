import * as frame from '@farcaster/frame-sdk';
import { createWalletClient, http, encodeFunctionData, formatEther, parseEther, zeroAddress, custom, decodeFunctionResult, createPublicClient } from 'viem';
import { base } from 'viem/chains';

// --- Constants ---
const CONTRACT_ADDRESS = '0x33a947b6F3448C1BEC58FEbEC56ACCC6BA200C17'; // Updated contract address
const TOKEN_ID = 1; // From CONTRACT_INTEGRATION.md

// --- DOM Elements ---
const nextValidBidEl = document.getElementById('next-valid-bid');
const timeLeftEl = document.getElementById('time-left');
const auctionItemImageEl = document.getElementById('auction-item-image');

const userFidDisplayEl = document.getElementById('user-fid'); // For the main bid area
const bidAmountInput = document.getElementById('bid-amount');
const placeBidButton = document.getElementById('place-bid-button');
const bidStatusEl = document.getElementById('bid-status');

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
let contractState = {
    reservePrice: BigInt(0),
    minIncrementBps: BigInt(0),
    highestBid: BigInt(0),
    highestBidder: zeroAddress, // Store address for internal logic if needed
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

// --- Initialization ---
async function init() {
    console.log("Initializing Win My Time - NFT Auction Frame...");
    try {
        const context = await frame.sdk.context;
        if (!context || !context.user) {
            console.error('Error: Not in a Farcaster frame context or user data is unavailable.');
            if (userFidDisplayEl) userFidDisplayEl.textContent = 'Frame Connection Error';
            if (placeBidButton) placeBidButton.disabled = true;
            if (bidStatusEl) bidStatusEl.textContent = "Frame connection issue. Bidding unavailable.";
            frame.sdk.actions.ready();
            return;
        }

        let user = context.user;
        if (user && user.user) user = user.user;
        currentUser.fid = user.fid;
        if (userFidDisplayEl) {
            userFidDisplayEl.textContent = user.fid ? user.fid.toString() : 'Not Found';
            // Text after FID span, if any, can be cleared or standardized if needed
        }

        ethProvider = await frame.sdk.wallet.ethProvider;
        if (!ethProvider) {
            console.error("Error: ethProvider is not available.");
            if (bidStatusEl) bidStatusEl.textContent = "Wallet provider not found. Bidding unavailable.";
            if (placeBidButton) placeBidButton.disabled = true;
            frame.sdk.actions.ready();
            return;
        }
        
        viemClient = createWalletClient({ chain: base, transport: custom(ethProvider) });
        const accounts = await ethProvider.request({ method: 'eth_requestAccounts' });
        if (accounts && accounts.length > 0) {
            currentUser.account = accounts[0];
            console.log("User account successfully connected:", currentUser.account);

            // Attempt to switch to Base network
            try {
                await ethProvider.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: '0x2105' }] // Base mainnet chainId (8453 decimal)
                });
                console.log("Successfully switched to or confirmed Base network.");
            } catch (switchError) {
                console.error("Error switching to Base network:", switchError);
                if (bidStatusEl) bidStatusEl.textContent = "Network switch to Base failed or was rejected. Bidding unavailable.";
                if (placeBidButton) placeBidButton.disabled = true;
                // We might want to prevent further contract calls if network switch fails
                frame.sdk.actions.ready();
                return; 
            }

        } else {
            console.error("Error: Could not get user account from wallet.");
            if (bidStatusEl) bidStatusEl.textContent = "Wallet connection required to bid.";
            if(placeBidButton) placeBidButton.disabled = true;
        }

        // Create a public client for read operations, connecting directly to a Base RPC
        publicClient = createPublicClient({
            chain: base,
            transport: http() // Uses default public RPC from viem's base chain definition
        });

        // Only proceed if account is available (which implies network switch was also attempted/successful)
        if (currentUser.account) {
            await fetchAuctionRenderData();
            await fetchUserStats();
        } else {
            // If no account, still try to fetch public auction data
            await fetchAuctionRenderData();
             if (nextValidBidEl) nextValidBidEl.textContent = "Connect Wallet for full info";
             if (timeLeftEl) timeLeftEl.textContent = "Connect Wallet for full info";
             if (userBidCountEl) userBidCountEl.textContent = "N/A (Connect Wallet)";
        }

        if (placeBidButton && currentUser.account && currentUser.fid) {
             placeBidButton.addEventListener('click', handlePlaceBid);
        } else if (placeBidButton) {
            placeBidButton.disabled = true; 
            console.warn("Place bid button disabled due to missing user account or FID.")
        }

        frame.sdk.actions.ready();
        console.log("Win My Time - NFT Auction Frame is ready.");

    } catch (error) {
        console.error("Initialization error:", error);
        if (userFidDisplayEl && userFidDisplayEl.querySelector('span')) userFidDisplayEl.querySelector('span').textContent = 'Error';
        if (bidStatusEl) bidStatusEl.textContent = `Initialization Error: ${error.message}`.substring(0, 70);
        try { frame.sdk.actions.ready(); } catch (e) { console.error("Error calling frame.sdk.actions.ready after failed initialization:", e); }
    }
}

// --- UI Update & Interaction Functions ---
function calculateNextValidBid() {
    if (!contractState.hasFirstBid) {
        return contractState.reservePrice;
    }
    // increment = highestBid * minIncrementBps / 10000
    const increment = (contractState.highestBid * contractState.minIncrementBps) / BigInt(10000);
    return contractState.highestBid + increment;
}

function updatePrimaryDisplay() {
    const nextBidWei = calculateNextValidBid();
    if (nextValidBidEl) nextValidBidEl.textContent = `${formatEther(nextBidWei)} ETH`;
    
    // Set default bid amount in input field
    if (bidAmountInput) {
        bidAmountInput.value = formatEther(nextBidWei); 
        bidAmountInput.min = formatEther(nextBidWei); // Ensure user can't bid lower than required
    }

    if (highestBidActualEl) highestBidActualEl.textContent = `${formatEther(contractState.highestBid)} ETH`;
}

function updateCountdown() {
    if (!timeLeftEl) return;
    if (auctionEndTime <= 0) {
        timeLeftEl.textContent = "Auction Ended";
        if(countdownInterval) clearInterval(countdownInterval);
        if(placeBidButton) placeBidButton.disabled = true;
        if(bidAmountInput) bidAmountInput.disabled = true;
        // TODO: Implement post-auction view / winner display
        return;
    }

    const now = Math.floor(Date.now() / 1000);
    const secondsRemaining = Math.max(0, Number(auctionEndTime) - now);

    if (secondsRemaining === 0) {
        timeLeftEl.textContent = "Auction Ending...";
        if(countdownInterval) clearInterval(countdownInterval);
        if(placeBidButton) placeBidButton.disabled = true;
        fetchAuctionRenderData(); 
        return;
    }

    const days = Math.floor(secondsRemaining / (3600 * 24));
    const hours = Math.floor((secondsRemaining % (3600 * 24)) / 3600);
    const minutes = Math.floor((secondsRemaining % 3600) / 60);
    const seconds = Math.floor(secondsRemaining % 60);
    
    let timeString = "";
    if (days > 0) timeString += `${days}d `;
    timeString += `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    timeLeftEl.textContent = timeString;

    // Make timer urgent if < softCloseWindow (e.g., 5 minutes = 300s)
    // This needs softCloseWindow from contract or a fixed value
    // For now, just an example if less than 1 hour
    if (secondsRemaining < 3600 && timeLeftEl) {
        timeLeftEl.classList.add('urgent');
    } else if (timeLeftEl) {
        timeLeftEl.classList.remove('urgent');
    }
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
                if (firstBidderBadgeEl) {
                    firstBidderBadgeEl.textContent = "(First Bidder)";
                    firstBidderBadgeEl.style.display = 'inline';
                }
            } else {
                firstBidderFidEl.textContent = 'N/A';
                if (firstBidderBadgeEl) firstBidderBadgeEl.style.display = 'none';
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
    if (!ethProvider || !viemClient || !currentUser.account || !currentUser.fid) {
        if (bidStatusEl) bidStatusEl.textContent = "Wallet or FID not connected. Please connect to bid.";
        return;
    }
    if (!bidAmountInput || !placeBidButton || !bidStatusEl) return;

    const bidAmountEthText = bidAmountInput.value;
    let bidAmountWei;
    try {
        bidAmountWei = parseEther(bidAmountEthText);
        if (bidAmountWei <= BigInt(0)) throw new Error("Bid amount must be greater than zero.");
    } catch (e) {
        bidStatusEl.textContent = "Invalid bid amount. Please enter a valid number.";
        bidStatusEl.style.color = '#e63946'; 
        return;
    }
    
    const nextMinBidWei = calculateNextValidBid();
    if (bidAmountWei < nextMinBidWei) {
        bidStatusEl.textContent = `Bid is below minimum. Minimum: ${formatEther(nextMinBidWei)} ETH.`;
        bidStatusEl.style.color = '#e63946';
        return;
    }

    placeBidButton.disabled = true;
    placeBidButton.textContent = "Submitting...";
    bidStatusEl.textContent = "Processing transaction...";
    bidStatusEl.style.color = '#00ffff'; // Using existing cyan for processing

    try {
        const data = encodeFunctionData({
            abi: auctionAbi, functionName: 'placeBid', args: [BigInt(currentUser.fid)]
        });

        const txHash = await ethProvider.request({
            method: 'eth_sendTransaction',
            params: [{ from: currentUser.account, to: CONTRACT_ADDRESS, data, value: '0x' + bidAmountWei.toString(16) }]
        });

        bidStatusEl.textContent = `Transaction submitted. Tx: ${txHash.substring(0,10)}...`;
        bidStatusEl.style.color = '#4CAF50'; 
        placeBidButton.textContent = "Processing...";
        
        setTimeout(() => { 
            fetchAuctionRenderData();
            fetchUserStats();
            bidStatusEl.textContent = "Bid status: Confirmed or check wallet.";
            placeBidButton.textContent = "Submit Bid";
            placeBidButton.disabled = false;
        }, 9000);

    } catch (error) {
        console.error("Error during bid placement:", error);
        let errorMsg = "Transaction failed or was rejected.";
        if (error.message && error.message.toLowerCase().includes("user rejected")) {
            errorMsg = "Transaction cancelled by user.";
        } else if (error.customMessage || error.message) {
            errorMsg = `Transaction Error: ${(error.customMessage || error.message)}`.substring(0,120);
        }
        bidStatusEl.textContent = errorMsg;
        bidStatusEl.style.color = '#e63946';
        placeBidButton.textContent = "Submit Bid";
        placeBidButton.disabled = false;
    } 
}

// --- Start the app ---
document.addEventListener('DOMContentLoaded', init); 