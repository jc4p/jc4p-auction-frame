import * as frame from '@farcaster/frame-sdk';
import { createWalletClient, http, encodeFunctionData, formatEther, parseEther, zeroAddress, custom, decodeFunctionResult, createPublicClient } from 'viem';
import { base } from 'viem/chains';

// --- Constants ---
const CONTRACT_ADDRESS = '0xa3bcabb39b280f5878571e6451dbbfcc1c1554b2'; // From CONTRACT_INTEGRATION.md
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
    { name: 'totalBids', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }
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
            await fetchContractConstants();
            await fetchAuctionData();
            await fetchUserStats();
            await fetchTokenMetadata();
        } else {
            // If no account, ensure UI reflects that data fetching won't proceed
             if (nextValidBidEl) nextValidBidEl.textContent = "Connect Wallet";
             if (timeLeftEl) timeLeftEl.textContent = "Connect Wallet";
             // etc. for other elements that depend on fetched data
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
        fetchAuctionData(); 
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
async function fetchContractConstants() {
    if (!publicClient) {
        console.warn("Public client not available for fetchContractConstants");
        if (nextValidBidEl) nextValidBidEl.textContent = "RPC Error";
        return;
    }
    try {
        console.log("Fetching contract constants (reserve, minIncrementBps)...");

        contractState.reservePrice = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'reservePrice'
        });

        contractState.minIncrementBps = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'minIncrementBps'
        });

        console.log(`Reserve: ${formatEther(contractState.reservePrice)} ETH, MinIncrementBPS: ${contractState.minIncrementBps.toString()}`);
    } catch(error) {
        console.error("Error fetching contract constants:", error);
        if (nextValidBidEl) nextValidBidEl.textContent = "Error";
    }
}

async function fetchAuctionData() {
    console.log("Fetching auction data...");
    if (!publicClient) {
        console.warn("Public client not available for fetchAuctionData");
        if (timeLeftEl) timeLeftEl.textContent = "RPC Error";
        return;
    }
    try {
        const endTimeFromContract = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'endTime'
        });
        auctionEndTime = Number(endTimeFromContract);

        if (countdownInterval) clearInterval(countdownInterval);
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);

        const auctionInfo = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'getAuctionInfo'
        });
        const [highestBidderAddr, highestBidWei] = auctionInfo;
        contractState.highestBid = highestBidWei;
        contractState.highestBidder = highestBidderAddr;

        if (highestBidderFidEl && highestBidderAddr !== zeroAddress) {
            try {
                const bidderStats = await publicClient.readContract({
                    address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'getBidderStats', args: [highestBidderAddr]
                });
                highestBidderFidEl.textContent = bidderStats[1].toString();
            } catch (fidError) {
                console.warn(`Could not fetch FID for highest bidder ${highestBidderAddr}:`, fidError);
                highestBidderFidEl.textContent = 'N/A';
            }
        } else if (highestBidderFidEl) {
            highestBidderFidEl.textContent = 'N/A';
        }

        contractState.hasFirstBid = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'hasFirstBid'
        });

        if (firstBidderFidEl) {
            if (contractState.hasFirstBid) {
                const fid = await publicClient.readContract({
                    address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'firstBidderFID'
                });
                firstBidderFidEl.textContent = fid.toString();
                if (firstBidderBadgeEl) {
                    firstBidderBadgeEl.textContent = "(First Bidder)";
                    firstBidderBadgeEl.style.display = 'inline';
                }
            } else {
                firstBidderFidEl.textContent = 'N/A';
                 if (firstBidderBadgeEl) firstBidderBadgeEl.style.display = 'none';
            }
        }

        contractState.totalBids = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'totalBids'
        });
        if(totalBidsEl) totalBidsEl.textContent = contractState.totalBids.toString();

        updatePrimaryDisplay();

    } catch (error) {
        console.error("Error fetching auction data:", error);
        if (nextValidBidEl) nextValidBidEl.textContent = "Error";
        if (timeLeftEl) timeLeftEl.textContent = "Error";
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

async function fetchTokenMetadata() {
    if (!publicClient || !auctionItemImageEl) {
        console.warn("Public client or image element not available for fetchTokenMetadata");
        return;
    }
    console.log("Fetching token metadata for token ID:", TOKEN_ID);
    try {
        const uri = await publicClient.readContract({
            address: CONTRACT_ADDRESS, abi: auctionAbi, functionName: 'tokenURI', args: [BigInt(TOKEN_ID)]
        });
        console.log("Token URI:", uri);

        if (uri && uri.startsWith('data:application/json;base64,')) {
            const metadata = JSON.parse(atob(uri.substring('data:application/json;base64,'.length)));
            console.log("Token Metadata:", metadata);
            if (metadata.image) {
                auctionItemImageEl.src = metadata.image;
                // Potentially update alt text from metadata.name if it aligns with "JC4P Exclusive Time NFT"
                // auctionItemImageEl.alt = metadata.name || "JC4P Exclusive Time NFT";
            }
            // Potentially update other UI elements with name/description if needed
        } else {
            console.warn("Token URI is not in the expected base64 format or is missing.");
            // Fallback or keep placeholder image
        }
    } catch (error) {
        console.error("Error fetching token metadata:", error);
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
            fetchAuctionData();
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