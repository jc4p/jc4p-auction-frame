// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "solady/utils/Base64.sol"; // For on-chain JSON, switched to Solady
import {LibString} from "solady/utils/LibString.sol"; // For uint to string conversion

contract JC4PNFT is ERC721 {
    uint256 public constant TOKEN_ID = 1;
    address public ownerOfToken; // As per spec for the single token owner

    string public constant NFT_NAME_METADATA = "JC4P Trading Card";
    string public constant NFT_DESCRIPTION = "A unique 1-of-1 trading card that provides the owner 4 hours of contracting time from the creator.";
    string public constant NFT_IMAGE_URL = "https://images.kasra.codes/nft-card/nft.jpg";

    // --- Auction Configuration State Variables (from SPEC_SHEET.md) ---
    address public immutable auctionOwner; // Set to msg.sender on deployment, manages auction parameters
    address public immutable beneficiary;  // Address that receives the auction proceeds
    uint256 public startTime;
    uint256 public endTime;
    uint256 public reservePrice;
    bool public auctionEnded;
    bool public softCloseEnabled;
    uint256 public softCloseWindow;     // seconds
    uint256 public softCloseExtension;  // seconds
    uint256 public minIncrementBps;     // e.g. 1000 = 10%

    // --- Bid State Variables (from SPEC_SHEET.md) ---
    address public firstBidder;
    uint64 public firstBidderFID;
    bool public hasFirstBid;

    address public highestBidder;
    uint64 public highestBidderFID;
    uint256 public highestBid;

    mapping(address => uint256) public bidCount;
    mapping(address => uint64) public bidderFID; // Stores the FID for a given bidder address

    uint256 public totalBids;

    // --- Events (from SPEC_SHEET.md) ---
    event BidPlaced(address indexed bidder, uint256 amount, uint64 fid);
    event AuctionExtended(uint256 newEndTime);
    event AuctionEnded(address indexed winner, uint256 amount); // Added indexed for winner
    event FundsWithdrawn(address indexed beneficiary, uint256 amount); // Event for withdrawal

    // Auction-related data to be included in metadata (actual values set on auction end)
    address internal actualAuctionWinner_ForMetadata;
    uint256 internal winningBidAmount_ForMetadata;
    uint64 internal winnerFid_ForMetadata;

    constructor(
        string memory _name,                // Contract name for ERC721, e.g., "JC4P Auction NFT"
        string memory _symbol,              // Contract symbol for ERC721, e.g., "JC4P"
        address _beneficiary,           // Auction specific: who gets the funds
        uint256 _reservePrice,          // Auction specific
        uint256 _auctionDurationSeconds,  // Auction specific
        uint256 _minIncrementBps,       // Auction specific
        bool _softCloseEnabled,         // Auction specific
        uint256 _softCloseWindow,       // Auction specific
        uint256 _softCloseExtension     // Auction specific
    ) ERC721(_name, _symbol) {
        require(_beneficiary != address(0), "Beneficiary cannot be zero address");
        auctionOwner = msg.sender;
        beneficiary = _beneficiary;
        startTime = block.timestamp;
        endTime = block.timestamp + _auctionDurationSeconds;
        reservePrice = _reservePrice;
        minIncrementBps = _minIncrementBps;
        softCloseEnabled = _softCloseEnabled;
        softCloseWindow = _softCloseWindow;
        softCloseExtension = _softCloseExtension;

        auctionEnded = false; // Explicitly set, though default is false
        // Other bid state variables default to zero/false/null which is correct initially
    }

    function _mintNFT(address to) internal {
        require(to != address(0), "ERC721: mint to the zero address");
        _mint(to, TOKEN_ID);
        ownerOfToken = to;
        
        // Set metadata variables upon minting to the winner
        actualAuctionWinner_ForMetadata = to;
        winningBidAmount_ForMetadata = highestBid; // This is the final winning bid amount
        winnerFid_ForMetadata = highestBidderFID; // This is the FID of the winner
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(tokenId == TOKEN_ID, "JC4PNFT: Only TOKEN_ID 1 exists");

        string memory auctionDataJson = ""; 

        if (actualAuctionWinner_ForMetadata != address(0)) {
            string memory winnerFidStr = LibString.toString(winnerFid_ForMetadata);
            string memory winningBidStr = LibString.toString(winningBidAmount_ForMetadata);
            
            auctionDataJson = string(abi.encodePacked(
                ',"attributes":[{"trait_type":"Winner FID","value":"', 
                winnerFidStr,
                '"},{"trait_type":"Winning Bid (wei)","value":"',
                winningBidStr,
                '"}]'
            ));
        }

        string memory json = Base64.encode( // Using Solady's Base64 encode
            bytes(
                string(
                    abi.encodePacked(
                        '{',
                        '"name": "', NFT_NAME_METADATA, '",',
                        '"description": "', NFT_DESCRIPTION, '",',
                        '"image": "', NFT_IMAGE_URL, '"',
                        auctionDataJson, // Append auction data here
                        '}'
                    )
                )
            )
        );

        return string(abi.encodePacked("data:application/json;base64,", json));
    }

    // --- Helper to check ERC721 compliance for ownerOf ---
    // This ensures our ownerOfToken is consistent if used externally,
    // but ERC721.ownerOf(TOKEN_ID) is the canonical source.
    function getNFTOwner() public view returns (address) {
        return ownerOfToken; // This will be address(0) until _mintNFT is called
    }

    // Override supportsInterface to advertise ERC721
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC721) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // --- Auction Logic Functions (to be implemented based on SPEC_SHEET.md) ---
    function placeBid(uint64 fid) external payable {
        require(!auctionEnded, "AuctionEnded: Auction has already ended");
        require(block.timestamp >= startTime, "AuctionNotStarted: Auction has not started yet");
        // End time check is subtle due to soft close. A bid must be placed *before* the current endTime.
        // The _extendAuctionIfNeeded will push endTime out if applicable.
        require(block.timestamp < endTime, "AuctionEnded: Auction has passed current end time");
        require(msg.value > 0, "BidTooLow: Bid amount must be greater than zero");

        uint256 currentMinBid = _calculateMinBid();
        require(msg.value >= currentMinBid, "BidTooLow: Bid does not meet minimum requirement");

        address oldHighestBidder = highestBidder;
        uint256 oldHighestBidAmount = highestBid;

        // Update bid state (highest bidder and their bid details)
        highestBid = msg.value;
        highestBidder = msg.sender;
        highestBidderFID = fid;

        // Refund previous highest bidder (if any and if different or if same bidder increasing bid)
        if (oldHighestBidder != address(0) && oldHighestBidAmount > 0) {
            // If the current bidder is the same as the old highest bidder, they are increasing their bid.
            // Their previous bid amount (oldHighestBidAmount) must be sent back to them.
            // If it's a new highest bidder, the oldHighestBidder (a different address) gets their oldHighestBidAmount back.
            (bool success, ) = oldHighestBidder.call{value: oldHighestBidAmount}("");
            require(success, "RefundFailed: Failed to refund previous bid");
        }

        // Track first bidder
        if (!hasFirstBid) {
            hasFirstBid = true;
            firstBidder = msg.sender;
            firstBidderFID = fid;
        }

        // Track bid counts
        bidCount[msg.sender]++;
        bidderFID[msg.sender] = fid; // Update/store FID for this bidder address
        totalBids++;

        // Extend auction if applicable (soft close)
        _extendAuctionIfNeeded();

        emit BidPlaced(msg.sender, msg.value, fid);
    }

    function _calculateMinBid() internal view returns (uint256) {
        if (!hasFirstBid) {
            return reservePrice;
        }
        // Calculate increment: highestBid * minIncrementBps / 10000 (100.00%)
        uint256 increment = (highestBid * minIncrementBps) / 10000;
        return highestBid + increment;
    }

    function _extendAuctionIfNeeded() internal {
        if (softCloseEnabled && (endTime - block.timestamp <= softCloseWindow)) {
            endTime = block.timestamp + softCloseExtension;
            emit AuctionExtended(endTime);
        }
    }

    function endAuction() external {
        require(!auctionEnded, "AuctionEnded: Auction already ended");
        require(block.timestamp >= endTime, "AuctionNotOver: Auction has not reached its end time yet");

        auctionEnded = true; // Mark auction as ended. If subsequent operations fail (like payout), this will be reverted.

        if (hasFirstBid) { // This implies reserve was met by the first bid, and highestBid >= reservePrice
            // Mint NFT to the highest bidder
            _mintNFT(highestBidder);

            // Transfer funds to beneficiary
            if (highestBid > 0) { // Ensure there are funds to send
                (bool success, ) = beneficiary.call{value: highestBid}("");
                require(success, "PayoutFailed: Failed to transfer funds to beneficiary");
            }
            // If highestBid was 0 (e.g. reserve 0) or payout successful, emit AuctionEnded
            emit AuctionEnded(highestBidder, highestBid);
        } else {
            // No valid bids met reserve, or no bids at all
            emit AuctionEnded(address(0), 0);
        }
    }

    // --- Optional Utility Functions (from SPEC_SHEET.md) ---

    /**
     * @notice Gets the number of bids and FID for a given address.
     * @param addr The address of the bidder.
     * @return count The number of bids placed by the address.
     * @return fid The Farcaster ID associated with the address's latest bid.
     */
    function getBidderStats(address addr) public view returns (uint256 count, uint64 fid) {
        count = bidCount[addr];
        fid = bidderFID[addr];
    }

    /**
     * @notice Gets key information about the current state of the auction.
     * @return highestBidder_ The address of the current highest bidder.
     * @return highestBid_ The current highest bid amount.
     * @return timeLeft_ The number of seconds remaining in the auction, or 0 if ended/not started.
     */
    function getAuctionInfo() public view returns (address highestBidder_, uint256 highestBid_, uint256 timeLeft_) {
        highestBidder_ = highestBidder;
        highestBid_ = highestBid;
        
        if (auctionEnded || block.timestamp < startTime) {
            timeLeft_ = 0;
        } else if (block.timestamp >= endTime) {
            timeLeft_ = 0; // Auction should have been ended, or is over.
        } else {
            timeLeft_ = endTime - block.timestamp;
        }
    }

    function withdraw() external {
        require(msg.sender == beneficiary, "Withdraw: Caller is not beneficiary");
        require(auctionEnded, "Withdraw: Auction not ended");
        
        uint256 balance = address(this).balance;
        require(balance > 0, "Withdraw: No balance");

        (bool success, ) = beneficiary.call{value: balance}("");
        require(success, "Withdraw: Transfer failed");

        emit FundsWithdrawn(beneficiary, balance);
    }
} 