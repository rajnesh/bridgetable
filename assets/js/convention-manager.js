/**
 * Bridge bidding conventions manager and utility functions.
 */

/**
 * Manages bridge bidding conventions and their configuration.
 */
class ConventionCard {
    static SUITS = ['C', 'D', 'H', 'S']; // Suit ordering

    constructor() {
        this._lastAuction = null;
        this.config = this._getDefaultConfig();
    }

    /**
     * Get default configuration.
     */
    _getDefaultConfig() {
        return {
            opening_bids: {
                strong_2_clubs: { enabled: true }
            },
            ace_asking: {
                gerber: {
                    enabled: true,
                    continuations: true,
                    responses_map: ['4D', '4H', '4S', '4NT']
                },
                blackwood: {
                    enabled: true,
                    variant: 'rkcb',
                    responses: '1430'
                }
            },
            slam_bidding: {
                control_showing_cue_bids: { enabled: true }
            },
            notrump_defenses: {
                dont: { enabled: true, style: 'standard' },
                unusual_nt: { enabled: true, direct: true, passed_hand: false, over_minors: false },
                lebensohl: { enabled: true, after_interference: true, fast_denies: true }
            },
            notrump_responses: {
                stayman: { enabled: true },
                jacoby_transfers: { enabled: true },
                texas_transfers: { enabled: true },
                minor_suit_transfers: { enabled: false, description: '2S transfers to clubs; 2NT transfers to diamonds over 1NT' }
            },
            responses: {
                jacoby_2nt: { enabled: true },
                splinter_bids: { enabled: true },
                // New: Bergen Raises (off by default)
                bergen_raises: { enabled: false, style: 'standard' },
                // Drury toggle
                drury: { enabled: true }
            },
            competitive: {
                michaels: { enabled: true, strength: 'wide_range', direct_only: true },
                responsive_doubles: { enabled: true, thru_level: 3, min_strength: 8 },
                negative_doubles: { enabled: true, thru_level: 3 },

                support_doubles: { enabled: true, thru: '2S' },
                cue_bid_raises: { enabled: true },
                reopening_doubles: { enabled: true },
                // Advancer raise configuration after partner's overcall
                advancer_raises: {
                    enabled: true,
                    simple_min_support: 3,         // 2M with 3+ trumps and simple range
                    simple_range: { min: 6, max: 10 },
                    jump_min_support: 4,           // default classic: require 4+ trumps for 3M jump raise
                    jump_range: { min: 11, max: 12 },
                    cuebid_min_support: 3,         // cue-bid raise with 3+ trumps
                    cuebid_min_hcp: 13             // 13+ HCP → cue-bid opener's suit as strong raise
                }
            },
            strong_club_defenses: {
                meckwell: { enabled: true, style: 'standard' }
            },
            preempts: {
                weak_two: { enabled: true }
            },
            general: {
                vulnerability_adjustments: true,
                passed_hand_variations: true,
                balance_of_power: true,
                relaxed_takeout_doubles: true,
                // Notrump responder ranges over minor openings (balanced, no 4-card major)
                // classic: 1NT=10–11, 2NT=12–14, 3NT=15+
                // wide:    1NT=6–11,  2NT=12–14, 3NT=15+
                nt_over_minors_range: 'classic',
                balanced_shapes: {
                    include_5422: false
                },
                // New: user-selectable behavior over interference of our 1NT opening
                systems_on_over_1nt_interference: {
                    stayman: false,
                    transfers: false,
                    stolen_bid_double: false
                }
            }
        };
    }

    /**
     * Load convention configuration (async for browser).
     */
    async loadConfig() {
        // Option B: Avoid CORS by using inline configuration when available; otherwise use built-in defaults
        try {
            if (typeof window !== 'undefined' && window.DEFAULT_CONVENTIONS_CONFIG) {
                this.config = window.DEFAULT_CONVENTIONS_CONFIG;
            } else {
                this.config = this._getDefaultConfig();
            }
            return this.config;
        } catch (error) {
            console.error('Error initializing convention configuration:', error);
            this.config = this._getDefaultConfig();
            return this.config;
        }
    }

    /**
     * Check if a specific convention is enabled.
     */
    isEnabled(convention, category = null) {
        try {
            if (category) {
                return this.config[category][convention].enabled;
            }
            // Search all categories if not specified
            for (const cat in this.config) {
                if (typeof this.config[cat] === 'object' && convention in this.config[cat]) {
                    return this.config[cat][convention].enabled;
                }
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    /**
     * Find the agreed trump suit from the auction context.
     */
    _findTrumpSuit(auction) {
        if (!auction.bids || auction.bids.length === 0) {
            return null;
        }

        const suitBids = [];
        let lastSuitBid = null;
        
        for (const bid of auction.bids) {
            if (!bid.token) continue; // Skip passes
            if (['S', 'H', 'D', 'C'].includes(bid.token.slice(-1))) {
                suitBids.push(bid);
                lastSuitBid = bid;
            }
        }

        // No suit bids found
        if (!lastSuitBid) return null;

        // Look for explicit suit agreement
        if (suitBids.length >= 2) {
            const lastSuit = lastSuitBid.token.slice(-1);
            
            // Consider it agreed if:
            // 1. The suit has been bid before
            for (let i = 0; i < suitBids.length - 1; i++) {
                if (suitBids[i].token.slice(-1) === lastSuit) {
                    return lastSuit;
                }
            }
            
            // 2. Last bid is jump to game in a major
            if (lastSuitBid.token.length === 2 &&
                lastSuitBid.token[0] === '4' &&
                ['S', 'H'].includes(lastSuit)) {
                return lastSuit;
            }
        }

        return null;
    }

    /**
     * Count key cards (4 aces + trump king) and queen for RKCB.
     * Returns {keycards, hasQueen}
     */
    _countRkcbKeycards(hand, trumpSuit) {
        // Count aces
        let keycards = 0;
        ['S', 'H', 'D', 'C'].forEach(suit => {
            hand.suitBuckets[suit].forEach(card => {
                if (card.rank === 'A') keycards++;
            });
        });

        // Add trump king if present
        if (hand.suitBuckets[trumpSuit].some(card => card.rank === 'K')) {
            keycards++;
        }

        // Check for trump queen
        const hasQueen = hand.suitBuckets[trumpSuit].some(card => card.rank === 'Q');

        return { keycards, hasQueen };
    }

    /**
     * Get a specific setting for a convention.
     */
    getConventionSetting(convention, setting, category = null) {
        try {
            if (category) {
                return this.config[category][convention][setting];
            }
            // Search all categories
            for (const cat in this.config) {
                if (typeof this.config[cat] === 'object' && convention in this.config[cat]) {
                    return this.config[cat][convention][setting];
                }
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Determine if a bid is an ace-asking bid and which convention applies.
     * Returns {isAceAsking, convention}
     */
    isAceAskingBid(auction, bid) {
        // Store auction context for response generation
        this._lastAuction = auction;

        if (!bid.token) {
            return { isAceAsking: false, convention: '' };
        }

        // Check for Gerber (4C over partner's NT, not when clubs are agreed trumps)
        if (this.isEnabled('gerber', 'ace_asking') && bid.token === '4C') {
            // Determine last contract prior to this bid
            let lastContract = null;
            let lastContractSeat = null;
            const bidsToScan = (auction.bids.length > 0 && auction.bids[auction.bids.length - 1] === bid)
                ? auction.bids.slice(0, -1)
                : auction.bids;
            for (let i = bidsToScan.length - 1; i >= 0; i--) {
                const prevBid = bidsToScan[i];
                if (prevBid.token && !prevBid.isDouble && !prevBid.isRedouble) {
                    lastContract = prevBid.token;
                    lastContractSeat = prevBid.seat || null;
                    break;
                }
            }

            // Only treat as Gerber if last contract was NT by our side
            if (lastContract && lastContract.slice(-2) === 'NT') {
                // Ensure the last NT was by our side, not opponents
                let lastNtSide = null;
                if (typeof auction.lastSide === 'function') {
                    // Temporarily simulate lastSide for lastContractSeat
                    const usNS = ['N', 'S'].includes(auction.ourSeat);
                    const lastIsNS = ['N', 'S'].includes(lastContractSeat);
                    lastNtSide = (usNS && lastIsNS) || (!usNS && !lastIsNS) ? 'we' : 'they';
                }

                const trumpSuit = this._findTrumpSuit(auction);
                const clubsAgreed = trumpSuit === 'C';

                if ((lastNtSide === 'we' || lastContractSeat === null) && !clubsAgreed) {
                    return { isAceAsking: true, convention: 'gerber' };
                }
            }
        }

        // Gerber continuations: 5C asks for kings after a Gerber response
        if (this.isEnabled('gerber', 'ace_asking') &&
            this.getConventionSetting('gerber', 'continuations', 'ace_asking') &&
            bid.token === '5C') {
            // Pattern: we bid 4C (ask), partner responded at 4D/4H/4S/4NT, we now bid 5C (king ask)
            const bids = auction.bids;
            // Find last 4C and ensure current 5C is by same seat (the original asker)
            let last4cIndex = -1;
            for (let i = bids.length - 1; i >= 0; i--) {
                if (bids[i].token === '4C') { last4cIndex = i; break; }
            }
            if (last4cIndex !== -1) {
                const askerSeat = bids[last4cIndex].seat;
                const currentSeat = bid.seat;
                // Validate one partner response in between and no new suit agreement
                const between = bids.slice(last4cIndex + 1, bids.length - 1).filter(x => x.token);
                const validResponseTokens = ['4D','4H','4S','4NT'];
                const hasSingleResponse = between.length === 1 && validResponseTokens.includes(between[0].token);
                if (askerSeat === currentSeat && hasSingleResponse) {
                    return { isAceAsking: true, convention: 'gerber_kings' };
                }
            }
        }

        // Check for Blackwood/RKCB
        if (bid.token === '4NT') {
            if (!this.isEnabled('blackwood', 'ace_asking')) {
                return { isAceAsking: false, convention: '' };
            }

            // Look for the last contract before this asking bid
            let lastContract = null;
            const bidsToScan = (auction.bids.length > 0 && auction.bids[auction.bids.length - 1] === bid)
                ? auction.bids.slice(0, -1)
                : auction.bids;
            
            for (let i = bidsToScan.length - 1; i >= 0; i--) {
                const prevBid = bidsToScan[i];
                if (prevBid.token && !prevBid.isDouble && !prevBid.isRedouble) {
                    lastContract = prevBid.token;
                    break;
                }
            }

            if (!lastContract) {
                return { isAceAsking: false, convention: '' };
            }

            if (lastContract.slice(-2) === 'NT') {
                return { isAceAsking: false, convention: '' };
            }

            const variant = this.getConventionSetting('blackwood', 'variant', 'ace_asking');

            // For RKCB, verify we have a trump suit established; if not, fall back to classic Blackwood
            if (variant === 'rkcb') {
                const trumpSuit = this._findTrumpSuit(auction);
                if (!trumpSuit) {
                    return { isAceAsking: true, convention: 'blackwood_classic' };
                }
                return { isAceAsking: true, convention: 'blackwood_rkcb' };
            }
            return { isAceAsking: true, convention: `blackwood_${variant}` };
        }

        return { isAceAsking: false, convention: '' };
    }

    /**
     * Generate response to ace-asking bid based on convention.
     */
    getAceAskingResponse(convention, hand) {
        if (convention === 'gerber') {
            const responsesMap = this.getConventionSetting('gerber', 'responses_map', 'ace_asking');

            let aceCount = 0;
            ['S', 'H', 'D', 'C'].forEach(suit => {
                hand.suitBuckets[suit].forEach(card => {
                    if (card.rank === 'A') aceCount++;
                });
            });

            // If a responses_map is configured and valid, use it
            if (Array.isArray(responsesMap) && responsesMap.length >= 4) {
                const idx = aceCount < 4 ? aceCount : 0;
                return responsesMap[idx];
            }

            // Default (standard) Gerber mapping fallback
            if (aceCount === 0 || aceCount === 4) return '4D';
            if (aceCount === 1) return '4H';
            if (aceCount === 2) return '4S';
            if (aceCount === 3) return '4NT';
            return '4D';

        } else if (convention === 'gerber_kings') {
            // Standard Gerber king ask: 5D=0/4, 5H=1, 5S=2, 5NT=3
            let kingCount = 0;
            ['S', 'H', 'D', 'C'].forEach(suit => {
                kingCount += hand.suitBuckets[suit].some(card => card.rank === 'K') ? 1 : 0;
            });

            if (kingCount === 0 || kingCount === 4) return '5D';
            if (kingCount === 1) return '5H';
            if (kingCount === 2) return '5S';
            if (kingCount === 3) return '5NT';
            return '5D';

        } else if (convention.startsWith('blackwood')) {
            const responses = this.getConventionSetting('blackwood', 'responses', 'ace_asking');
            
            if (convention === 'blackwood_rkcb') {
                const trumpSuit = this._findTrumpSuit(this._lastAuction);
                if (!trumpSuit) return null;

                const { keycards, hasQueen } = this._countRkcbKeycards(hand, trumpSuit);

                // Roman Keycard responses:
                // 1430: 5♣=1/4, 5♦=3/0, 5♥=2 no Q, 5♠=2+Q, 5NT=odd+Q
                // 3014: 5♣=3/0, 5♦=1/4, 5♥=2 no Q, 5♠=2+Q, 5NT=odd+Q
                if (responses === '1430') {
                    if ([1, 4].includes(keycards)) return '5C';
                    if ([3, 0].includes(keycards)) return '5D';
                    if (keycards === 2) return hasQueen ? '5S' : '5H';
                    return '5NT';
                } else { // 3014 responses
                    if ([3, 0].includes(keycards)) return '5C';
                    if ([1, 4].includes(keycards)) return '5D';
                    if (keycards === 2) return hasQueen ? '5S' : '5H';
                    return '5NT';
                }
            } else if (convention === 'blackwood_classic') {
                let aceCount = 0;
                ['S', 'H', 'D', 'C'].forEach(suit => {
                    hand.suitBuckets[suit].forEach(card => {
                        if (card.rank === 'A') aceCount++;
                    });
                });

                if (aceCount === 0 || aceCount === 4) return '5C';
                if (aceCount === 1) return '5D';
                if (aceCount === 2) return '5H';
                if (aceCount === 3) return '5S';
                return '5C';
            }
        }

        return null;
    }

    /**
     * Determine if a bid shows two suits and which suits are shown.
     * Returns {isTwoSuited, convention, suits}
     */
    isTwoSuitedOvercall(auction, bid, hand = null) {
        if (!bid.token) {
            return { isTwoSuited: false, convention: '', suits: [] };
        }

        // Check for Michaels Cue-bid
        if (this.isEnabled('michaels', 'competitive')) {
            const style = this.getConventionSetting('michaels', 'strength', 'competitive');
            const directOnly = this.getConventionSetting('michaels', 'direct_only', 'competitive');

            // If direct_only is configured, require that this 2-level cue bid is a direct
            // overcall (i.e., there were no non-PASS bids after the opening). The previous
            // check used auction.bids.length which can be >1 due to leading PASSES and
            // incorrectly rejected valid direct-seat cue-bids. Instead, scan the auction
            // to ensure the opening was immediately followed only by PASSes until now.
            if (directOnly) {
                const openingToken = auction.lastContract();
                let sawOpening = false;
                for (const b of auction.bids) {
                    const t = b?.token || 'PASS';
                    if (!sawOpening) {
                        if (t === openingToken) sawOpening = true;
                        continue;
                    }
                    // If anything other than PASS occurred after the opening, it's not direct
                    if (t !== 'PASS') {
                        return { isTwoSuited: false, convention: '', suits: [] };
                    }
                }
            }

            const lastContract = auction.lastContract();
            if (bid.token[0] === '2' &&
                lastContract &&
                lastContract[0] === '1' &&
                bid.token[1] === lastContract[1]) {
                
                // Validate hand shape if provided and classify correct suits
                if (hand) {
                    const minHcp = style === 'wide_range' ? 6 : 10;
                    if (hand.hcp < minHcp) {
                        return { isTwoSuited: false, convention: '', suits: [] };
                    }

                    // For a minor opening (1C/1D) Michaels shows both majors (H+S)
                    if (['C','D'].includes(lastContract[1])) {
                        if ((hand.lengths['H'] || 0) >= 5 && (hand.lengths['S'] || 0) >= 5) {
                            return { isTwoSuited: true, convention: 'michaels', suits: ['H','S'] };
                        }
                        return { isTwoSuited: false, convention: '', suits: [] };
                    }

                    // For a major opening (1H/1S) Michaels shows the other major + a minor.
                    const otherMajor = lastContract[1] === 'S' ? 'H' : 'S';
                    // Prefer the minor with 5+ cards if present
                    const minorSuit = (hand.lengths['C'] || 0) >= 5 ? 'C' : ((hand.lengths['D'] || 0) >= 5 ? 'D' : null);
                    if ((hand.lengths[otherMajor] || 0) >= 5 && minorSuit) {
                        return { isTwoSuited: true, convention: 'michaels', suits: [otherMajor, minorSuit] };
                    }
                    return { isTwoSuited: false, convention: '', suits: [] };
                }
            }
        }

        // Check for Unusual NT (two lowest unbid suits), shape-aware when hand provided
        if (this.isEnabled('unusual_nt', 'notrump_defenses')) {
            const lastContract = auction.lastContract();
            if (bid.token === '2NT' && lastContract && lastContract[0] === '1') {
                try {
                    const openingSuit = lastContract[1];
                    const order = ['C','D','H','S'];
                    // Two lowest unbid suits relative to opening suit
                    const unbid = order.filter(s => s !== openingSuit);
                    const lowestTwo = unbid.slice(0, 2);

                    // Enforce direct overcall if configured
                    const directOnly = !!(this.config?.notrump_defenses?.unusual_nt?.direct);
                    if (directOnly) {
                        // Determine the opening token (first contract bid in the auction)
                        let openingToken = null;
                        for (const b of auction.bids) {
                            const t = b?.token || (b?.isDouble ? 'X' : b?.isRedouble ? 'XX' : 'PASS');
                            if (t && /^[1-7]/.test(t)) { openingToken = t; break; }
                        }
                        if (!openingToken) return { isTwoSuited: false, convention: '', suits: [] };
                        // Require that there are no other non-pass bids after the opening before this 2NT is considered Unusual
                        let sawOpening = false;
                        for (const b of auction.bids) {
                            const t = b?.token || (b?.isDouble ? 'X' : b?.isRedouble ? 'XX' : 'PASS');
                            if (!sawOpening) {
                                if (t === openingToken) sawOpening = true;
                                continue;
                            }
                            if (t !== 'PASS') {
                                // If anything else happened, treat as not direct for classification purposes
                                return { isTwoSuited: false, convention: '', suits: [] };
                            }
                        }
                    }

                    // If hand is provided, validate 5-5 length in the two lowest unbid suits
                    if (hand && hand.lengths) {
                        const a = lowestTwo[0], b = lowestTwo[1];
                        if (!a || !b) return { isTwoSuited: false, convention: '', suits: [] };
                        if ((hand.lengths[a] || 0) < 5 || (hand.lengths[b] || 0) < 5) {
                            return { isTwoSuited: false, convention: '', suits: [] };
                        }
                    }

                    return { isTwoSuited: true, convention: 'unusual_nt', suits: lowestTwo };
                } catch (_) {
                    // On any parsing error, be conservative and do not classify as two-suited
                    return { isTwoSuited: false, convention: '', suits: [] };
                }
            }
        }

        return { isTwoSuited: false, convention: '', suits: [] };
    }

    /**
     * Adjust HCP requirements based on vulnerability.
     * Returns {minAdjust, maxAdjust}
     */
    adjustForVulnerability(bidType, vul) {
        if (!this.config.general.vulnerability_adjustments) {
            return { minAdjust: 0, maxAdjust: 0 };
        }

        const adjustments = {
            'overcall': { fav: -1, unfav: 1 },
            'preempt': { fav: -2, unfav: 2 },
            // Tune weak two vulnerability: slightly tighter when vulnerable, not overly punitive
            'weak_two': { fav: -1, unfav: 4 }
        };

        if (!(bidType in adjustments)) {
            return { minAdjust: 0, maxAdjust: 0 };
        }

        const weVul = vul.we;
        const theyVul = vul.they;

        if (weVul && !theyVul) {  // Unfavorable
            return { minAdjust: adjustments[bidType].unfav, maxAdjust: 0 };
        } else if (!weVul && theyVul) {  // Favorable
            return { minAdjust: adjustments[bidType].fav, maxAdjust: 0 };
        }
        return { minAdjust: 0, maxAdjust: 0 };  // Equal vulnerability
    }
}

// Browser global exports
if (typeof window !== 'undefined') {
    window.ConventionCard = ConventionCard;
}

// Node.js exports
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ConventionCard
    };
}
