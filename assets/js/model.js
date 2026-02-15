/**
 * model.js
 * Handles loading the TensorFlow.js bidding model and running inference.
 */

const HAND_FEATS_DIM = 52;
const AUX_CTX_DIM = 10;
const NUM_CONVENTIONS = 1;
const MAX_AUCTION_LEN = 40;

// Bid tokens mapping
const CALLS = {
    PASS: 0,
    X: 1,
    XX: 2
};
const DENOMINATIONS = ['C', 'D', 'H', 'S', 'N'];
const SUITS = { C: 0, D: 1, H: 2, S: 3 };
const RANKS = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, T: 8, J: 9, Q: 10, K: 11, A: 12 };

let model = null;
let BID_LABELS = [];

/**
 * Loads the TensorFlow.js model.
 * @param {string} modelPath
 * @param {string} tokensPath (unused, kept for signature compatibility)
 */
export async function loadModel(modelPath = '../models/bid_rl_model/model.json', tokensPath = './bid_tokens.json') {
    if (model) {
        console.log('Bidding model already loaded.');
        return;
    }

    // Populate BID_LABELS
    BID_LABELS = ['PASS', 'X', 'XX'];
    for (let level = 1; level <= 7; level++) {
        for (const denom of DENOMINATIONS) {
            BID_LABELS.push(`${level}${denom}`);
        }
    }

    try {
        //console.log(`Loading bidding model from ${modelPath}...`);

        // Prefer webgl for performance; fall back to current/default backend if unavailable.
        if (tf?.setBackend) {
            try {
                await tf.setBackend('webgl');
                await tf.ready();
                //console.log(`Bidding model using backend: ${tf.getBackend()}`);
            } catch (be) {
                console.warn('WebGL backend unavailable, using default:', be?.message || be);
            }
        }

        model = await tf.loadGraphModel(modelPath);
        // console.log('Bidding model loaded. Warming up...');

        // Warmup with representative shapes/values on the active backend.
        try {
            const auctionTensor = tf.tensor2d([getAuctionTensor([])], [1, MAX_AUCTION_LEN], 'int32');
            const handFeatsTensor = tf.zeros([1, HAND_FEATS_DIM], 'float32');
            const convFeatsTensor = tf.ones([1, NUM_CONVENTIONS], 'float32');
            const auxFeatsTensor = tf.zeros([1, AUX_CTX_DIM], 'float32');

            const inputMap = {
                'auction_seq': auctionTensor,
                'auction_seq:0': auctionTensor,
                'hand_feats': handFeatsTensor,
                'hand_feats:0': handFeatsTensor,
                'conv_feats': convFeatsTensor,
                'conv_feats:0': convFeatsTensor,
                'aux_feats': auxFeatsTensor,
                'aux_feats:0': auxFeatsTensor
            };

            const ordered = model?.inputs?.map(inp => {
                const key = inp.name;
                return inputMap[key] || inputMap[key.replace(/:0$/, '')];
            }) || [];

            try {
                const out = await model.executeAsync(inputMap);
                Array.isArray(out) ? tf.dispose(out) : tf.dispose(out);
                // console.log(`Bidding model warmup (map async, backend=${tf.getBackend ? tf.getBackend() : 'unknown'}) complete.`);
            } catch (e1) {
                const outArr = await model.executeAsync(ordered);
                Array.isArray(outArr) ? tf.dispose(outArr) : tf.dispose(outArr);
                //console.log(`Bidding model warmup (array async, backend=${tf.getBackend ? tf.getBackend() : 'unknown'}) complete.`);
            } finally {
                tf.dispose([auctionTensor, handFeatsTensor, convFeatsTensor, auxFeatsTensor]);
            }
        } catch (warmErr) {
            //console.warn('Bidding model warmup failed (continuing):', warmErr);
        }
    } catch (err) {
        console.error('Failed to load bidding model:', err);
    }
}

/**
 * Creates the auction tensor from the bidding history.
 * @param {Array<string>} auction - e.g., ["1H", "PASS", "2H"]
 * @returns {Int32Array}
 */
function getAuctionTensor(auction) {
    const tokens = auction.map(bid => {
        const b = bid.toUpperCase();
        if (CALLS[b] !== undefined) return CALLS[b];
        // Parse bid: Level + Denom
        const level = parseInt(b[0]);
        const denom = b.substring(1);
        const denomIdx = DENOMINATIONS.indexOf(denom);
        if (level >= 1 && level <= 7 && denomIdx !== -1) {
            return (level - 1) * 5 + denomIdx + 3;
        }
        return 0; // Fallback to PASS
    });

    // Start filled with padding token (PASS/0) so masks that rely on zero-padding behave as trained.
    const paddedTokens = new Int32Array(MAX_AUCTION_LEN).fill(CALLS.PASS);
    // Right-pad: align bids to the tail; overwrite the padding with real tokens when present.
    const start = Math.max(0, MAX_AUCTION_LEN - tokens.length);
    for (let i = 0; i < tokens.length && i < MAX_AUCTION_LEN; i++) {
        paddedTokens[start + i] = tokens[i];
    }
    return paddedTokens;
}

/**
 * Generates hand features from a player's hand.
 * Returns a 52-element one-hot encoded vector (Rank-major order: 2C, 2D, 2H, 2S, 3C...).
 * @param {object|Array} hand - Hand object or array of card strings.
 * @returns {Float32Array} - A 52-element feature vector.
 */
function getHandFeatures(hand) {
    const features = new Float32Array(HAND_FEATS_DIM).fill(0);

    // Helper to set bit
    const setBit = (rankChar, suitChar) => {
        const r = RANKS[rankChar];
        const s = SUITS[suitChar];
        if (r !== undefined && s !== undefined) {
            // Rank-major order: rank * 4 + suit
            // C=0, D=1, H=2, S=3
            const idx = r * 4 + s;
            if (idx >= 0 && idx < 52) {
                features[idx] = 1.0;
            }
        }
    };

    if (hand && typeof hand === 'object' && hand.suitBuckets) {
        // Hand object from bridge-types.js
        ['S', 'H', 'D', 'C'].forEach(suit => {
            if (hand.suitBuckets[suit]) {
                hand.suitBuckets[suit].forEach(card => {
                    // card is { rank: 'A', suit: 'S' }
                    setBit(card.rank, card.suit);
                });
            }
        });
    } else if (Array.isArray(hand)) {
        // Array of strings (fallback)
        hand.forEach(cardStr => {
            if (typeof cardStr === 'string' && cardStr.length >= 2) {
                // Try to detect format: "AS" or "SA"
                let r = cardStr[0];
                let s = cardStr[1];
                // If first char is suit, swap
                if (SUITS[r] !== undefined && RANKS[s] !== undefined) {
                    const temp = r; r = s; s = temp;
                }
                setBit(r, s);
            }
        });
    }

    return features;
}

/**
 * Uses the model to predict the next bid.
 * @param {Array<string>} auction - The current auction sequence.
 * @param {Array<string>} hand - The player's hand.
 * @param {object} context - Context info: { dealer: 'N', vulnerability: {ns:false, ew:false}, currentTurn: 'N' }
 * @returns {Promise<string>} The predicted bid as a string (e.g., "1H").
 */
export async function getModelBid(auction, hand, context = {}) {
    if (!model) {
        console.error("Model not loaded. Call loadModel() first.");
        return "PASS";
    }

    // Defensive: enforce auction length contract the model was converted with.
    const auctionLen = Array.isArray(auction) ? auction.length : 0;
    if (auctionLen > MAX_AUCTION_LEN) {
        throw new Error(`auction_seq length ${auctionLen} exceeds MAX_AUCTION_LEN ${MAX_AUCTION_LEN}`);
    }
    const auctionInput = (model?.inputs || []).find(inp => inp.name === 'auction_seq' || inp.name === 'auction_seq:0');
    const declaredAuctionLen = auctionInput?.shape?.[1];
    if (declaredAuctionLen && declaredAuctionLen !== MAX_AUCTION_LEN) {
        throw new Error(`Model expects auction_seq length ${declaredAuctionLen} but loader MAX_AUCTION_LEN=${MAX_AUCTION_LEN}`);
    }

    // 1. Prepare model inputs
    const auctionTensor = tf.tensor2d([getAuctionTensor(auction)], [1, MAX_AUCTION_LEN], 'int32');
    const handFeatsTensor = tf.tensor2d([getHandFeatures(hand)]);
    const convFeatsTensor = tf.ones([1, NUM_CONVENTIONS]);

    // Aux features
    const auxFeats = new Float32Array(AUX_CTX_DIM).fill(0);

    const seatMap = { 'N': 0, 'E': 1, 'S': 2, 'W': 3 };
    const currentSeat = seatMap[context.currentTurn] !== undefined ? seatMap[context.currentTurn] : 0;
    const dealerSeat = seatMap[context.dealer] !== undefined ? seatMap[context.dealer] : 0;

    // 0-3: Current player one-hot
    auxFeats[currentSeat] = 1.0;

    // Vul
    const vulNS = context.vulnerability?.ns ? 1 : 0;
    const vulEW = context.vulnerability?.ew ? 1 : 0;

    // Dealer partnership: 0 (N/S) or 1 (E/W)
    const dealerPartnership = dealerSeat % 2;
    const nonDealerPartnership = (dealerSeat + 1) % 2;

    // 4: Dealer partnership vul
    if ((dealerPartnership === 0 && vulNS) || (dealerPartnership === 1 && vulEW)) {
        auxFeats[4] = 1.0;
    }

    // 5: Non-dealer partnership vul
    if ((nonDealerPartnership === 0 && vulNS) || (nonDealerPartnership === 1 && vulEW)) {
        auxFeats[5] = 1.0;
    }

    // 6-9: Dealer one-hot
    auxFeats[6 + dealerSeat] = 1.0;

    const auxFeatsTensor = tf.tensor2d([auxFeats]);

    // 2. Run inference
    // Build a map keyed by the actual model input names (including :0) to avoid mis-ordering
    const tensorMap = {
        // Preferred names from model signature
        'auction_seq': auctionTensor,
        'auction_seq:0': auctionTensor,
        'hand_feats': handFeatsTensor,
        'hand_feats:0': handFeatsTensor,
        'conv_feats': convFeatsTensor,
        'conv_feats:0': convFeatsTensor,
        'aux_feats': auxFeatsTensor,
        'aux_feats:0': auxFeatsTensor,
        // Legacy fallbacks kept for safety
        'auction': auctionTensor,
        'auction:0': auctionTensor,
        'hand': handFeatsTensor,
        'hand:0': handFeatsTensor,
        'convention': convFeatsTensor,
        'convention:0': convFeatsTensor,
        'aux': auxFeatsTensor,
        'aux:0': auxFeatsTensor
    };

    const inputs = {};
    if (Array.isArray(model?.inputs)) {
        model.inputs.forEach(inp => {
            const key = inp.name;
            if (tensorMap[key] !== undefined) {
                inputs[key] = tensorMap[key];
            } else if (tensorMap[key.replace(/:0$/, '')] !== undefined) {
                inputs[key] = tensorMap[key.replace(/:0$/, '')];
            }
        });
    }
    // Fallback: if for some reason no inputs were added (unexpected), use the plain names
    if (!Object.keys(inputs).length) {
        inputs['auction_seq'] = auctionTensor;
        inputs['hand_feats'] = handFeatsTensor;
        inputs['conv_feats'] = convFeatsTensor;
        inputs['aux_feats'] = auxFeatsTensor;
    }

    // Helpful debug when unexpected shape errors occur
    const logDebugShapes = (stage = '') => {
        try {
            const inputsMeta = (model?.inputs || []).map(inp => ({ name: inp.name, shape: inp.shape }));
            console.warn(`DEBUG ${stage} model.inputs order:`, JSON.stringify(inputsMeta));
            console.warn(`DEBUG ${stage} map keys:`, Object.keys(inputs));
            console.warn('DEBUG auctionTensor shape:', auctionTensor.shape, 'sum=', tf.sum(auctionTensor).arraySync());
            console.warn('DEBUG handFeatsTensor shape:', handFeatsTensor.shape, 'sum=', tf.sum(handFeatsTensor).arraySync());
            console.warn('DEBUG convFeatsTensor shape:', convFeatsTensor.shape, 'sum=', tf.sum(convFeatsTensor).arraySync());
            console.warn('DEBUG auxFeatsTensor shape:', auxFeatsTensor.shape, 'sum=', tf.sum(auxFeatsTensor).arraySync());
        } catch (_) { /* best-effort */ }
    };

    let resultTensor;
    try {
        resultTensor = await model.executeAsync(inputs);
    } catch (e) {
        console.error("Model execution failed:", e);
        logDebugShapes('primary');
        // Fallback to array if map fails (though map is preferred)
        try {
            // Align array order with model.inputs to avoid shape mismatches when names are ignored
            const ordered = model.inputs?.map(inp => inp.name.replace(/:0$/, '')) || [];
            const arr = ordered.length ? ordered.map(k => tensorMap[k]) : [convFeatsTensor, handFeatsTensor, auctionTensor, auxFeatsTensor];
            console.warn('DEBUG fallback ordered names:', JSON.stringify(ordered));
            resultTensor = await model.executeAsync(arr);
        } catch (e2) {
            console.error("Model execution fallback failed:", e2);
            logDebugShapes('fallback');
            return { token: "PASS", confidence: 0 };
        }
    }

    // 3. Get result
    const logits = await resultTensor.data();

    // Apply legality mask
    // We need to implement `getLegalityMask` properly or reuse logic.
    // The previous `model.js` had a simplified `getLegalityMask`.
    // I should include a robust one or at least the simplified one.
    const mask = getLegalityMask(auction);

    // Collect legal logits and compute softmax-based confidence
    const legal = [];
    for (let i = 0; i < logits.length; i++) {
        if (mask[i]) legal.push({ idx: i, logit: logits[i] });
    }

    tf.dispose([auctionTensor, handFeatsTensor, convFeatsTensor, auxFeatsTensor, resultTensor]);

    if (!legal.length) {
        return { token: "PASS", confidence: 0 };
    }

    let maxLogit = -Infinity;
    for (const entry of legal) {
        if (entry.logit > maxLogit) maxLogit = entry.logit;
    }
    let expSum = 0;
    for (const entry of legal) {
        expSum += Math.exp(entry.logit - maxLogit);
    }
    let best = legal[0];
    for (const entry of legal) {
        if (entry.logit > best.logit) best = entry;
    }
    const bestProb = expSum ? Math.exp(best.logit - maxLogit) / expSum : 0;
    return { token: BID_LABELS[best.idx], confidence: bestProb };
}

/**
 * Generates a basic legality mask.
 * @param {Array<string>} auction - The current auction sequence.
 * @returns {boolean[]}
 */
function getLegalityMask(auction) {
    // Re-implementing simplified legality
    const mask = new Array(BID_LABELS.length).fill(true);
    mask[0] = true; // Pass is always legal

    // Find last bid
    let lastBidIdx = -1;
    let lastBidder = -1; // 0=LHO, 1=Partner, 2=RHO (relative to current)
    // Actually we just need to know if there was a bid, double, or redouble.

    // We need to parse the auction to find the contract state.
    // This is complex to do perfectly without full state.
    // But we can do a decent job.

    let contractBid = null;
    let contractBidIdx = -1;
    let doubleStatus = 0; // 0=none, 1=dbl, 2=rdbl
    let consecutivePasses = 0;

    for (const bid of auction) {
        const b = bid.toUpperCase();
        if (b === 'PASS') {
            consecutivePasses++;
        } else if (b === 'X') {
            doubleStatus = 1;
            consecutivePasses = 0;
        } else if (b === 'XX') {
            doubleStatus = 2;
            consecutivePasses = 0;
        } else {
            contractBid = b;
            contractBidIdx = BID_LABELS.indexOf(b);
            doubleStatus = 0;
            consecutivePasses = 0;
        }
    }

    // If no bid yet, any bid is legal. X/XX illegal.
    if (contractBid === null) {
        mask[1] = false; // X
        mask[2] = false; // XX
        return mask;
    }

    // If we have a contract
    // Can we double?
    // Only if last call was a bid (by opponent) or ...
    // We need to know who made the bid.
    // If `consecutivePasses` is 0, last call was bid/X/XX.
    // If 1, last was Pass (by RHO). Call before that was LHO.
    // If 2, last was Pass (RHO), Pass (Partner). Call before was LHO.

    // This is hard without knowing whose turn it is relative to the contract.
    // But we can assume standard rotation.
    // If consecutivePasses == 0:
    //   Last was Bid -> Opponent made it. We can Double.
    //   Last was X -> Opponent doubled our partner. We can Redouble.
    //   Last was XX -> Opponent redoubled. We can only Bid or Pass.

    // Wait, if last was Bid, it was RHO. We can Double.
    // If last was X, it was RHO doubling Partner. We can XX.
    // If last was XX, it was RHO redoubling Partner's X. We can Bid.

    // If consecutivePasses == 1:
    //   RHO passed. Last action was Partner.
    //   If Partner Bid -> We cannot Double/Redouble. We can Bid higher.
    //   If Partner X -> We cannot Double. We can Bid.
    //   If Partner XX -> We cannot Double. We can Bid.

    // If consecutivePasses == 2:
    //   RHO Pass, Partner Pass. Last action was LHO.
    //   Same as consecutivePasses == 0.

    // So:
    // If passes % 2 == 0 (0 or 2): Opponent acted last (or LHO acted, then 2 passes).
    //   If last non-pass was Bid: Can Double.
    //   If last non-pass was X: Can Redouble.
    //   If last non-pass was XX: Cannot X/XX.

    // If passes % 2 == 1 (1): Partner acted last.
    //   Cannot X/XX.

    const lastAction = auction.length > 0 ? auction[auction.length - 1 - consecutivePasses] : null;
    const lastActionIsBid = lastAction && lastAction !== 'PASS' && lastAction !== 'X' && lastAction !== 'XX';
    const lastActionIsX = lastAction === 'X';
    const lastActionIsXX = lastAction === 'XX';

    const opponentActedLast = (consecutivePasses % 2 === 0);

    if (opponentActedLast) {
        if (lastActionIsBid) {
            mask[1] = true; // Can Double
            mask[2] = false;
        } else if (lastActionIsX) {
            mask[1] = false;
            mask[2] = true; // Can Redouble
        } else {
            mask[1] = false;
            mask[2] = false;
        }
    } else {
        // Partner acted last
        mask[1] = false;
        mask[2] = false;
    }

    // Bids must be higher than contractBid
    if (contractBidIdx !== -1) {
        for (let i = 3; i <= contractBidIdx; i++) {
            mask[i] = false;
        }
    }

    return mask;
}

// Export helper to set context if we want to enhance it later
export function setContext(ctx) {
    // Placeholder
}
