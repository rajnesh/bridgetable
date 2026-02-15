/**
 * Main application logic for the Bridge Bidding System web interface.
 * Enhanced version with hand generation, auction management, and automated bidding.
 */

// Import the bidding model handler
import { loadModel as loadBiddingModel, getModelBid } from './model.js';

// Minimum confidence required to accept a model fallback bid
const MODEL_CONFIDENCE_THRESHOLD = 0.35;

let system = null;
let systemReady = false;
let generationMode = 'random';
// Global state used across the UI (restored to avoid ReferenceErrors at runtime)
let currentHands = { N: null, E: null, S: null, W: null };
// Expose and keep a reference on window for jsdom/tests and cross-script access
try { if (typeof window !== 'undefined') { window.currentHands = currentHands; } } catch (_) { }
// Initialize auction state with safe defaults for tests and UI
let auctionActive = false;
let auctionHistory = [];
let currentAuction = [];
let currentTurn = null;
let dealer = 'S';
// Capture of console output scoped to the Auction tab
let auctionConsoleLog = [];
let __originalConsole = null;
function startAuctionConsoleCapture() {
    try {
        if (__originalConsole) return; // already capturing
        __originalConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug
        };
        auctionConsoleLog = [];
        const shouldCapture = (text) => {
            const lower = (text || '').toLowerCase();
            const noisy = ['button', 'onclick', 'class', 'style', 'display', 'element', 'aria', 'tab', 'chevron', 'resize', 'width', 'height', 'scroll', 'color', 'padding', 'margin', 'border', 'icon'];
            return !noisy.some(k => lower.includes(k));
        };
        const pushMessage = (level, ...args) => {
            try {
                const ts = new Date().toISOString();
                const text = args.map(a => {
                    try { return (typeof a === 'string') ? a : (JSON.stringify(a)); } catch (_) { return String(a); }
                }).join(' ');
                if (!shouldCapture(text)) return; // skip UI/noise logs
                auctionConsoleLog.push(`${ts} [${level.toUpperCase()}] ${text}`);
            } catch (_) { }
        };
        console.log = function (...args) { pushMessage('log', args); __originalConsole.log.apply(console, args); };
        console.info = function (...args) { pushMessage('info', args); __originalConsole.info.apply(console, args); };
        console.warn = function (...args) { pushMessage('warn', args); __originalConsole.warn.apply(console, args); };
        console.error = function (...args) { pushMessage('error', args); __originalConsole.error.apply(console, args); };
        console.debug = function (...args) { pushMessage('debug', args); __originalConsole.debug.apply(console, args); };
    } catch (e) {
        try { __originalConsole?.warn('startAuctionConsoleCapture failed', e); } catch (_) { }
    }
}

function computeTotalPoints(hand) {
    try {
        const hcp = typeof hand?.hcp === 'number' ? hand.hcp : 0;
        let dp = 0;
        try { dp = calculateShortnessPoints(hand); } catch (_) { dp = 0; }
        return hcp + dp;
    } catch (_) {
        return 0;
    }
}

// Inline guard helpers (migrated from the former auction-logic-guards.js)
function sameSide(seatA, seatB) {
    if (!seatA || !seatB) return false;
    const tag = (s) => (s === 'N' || s === 'S') ? 'NS' : 'EW';
    return tag(seatA) === tag(seatB);
}

function applyResponderMajorGuard({
    recommendedBid,
    explanation,
    forcedBid,
    currentTurn,
    auctionHistory,
    hand,
    isValidSystemBid,
    computeTotalPoints: computeTotalPointsFn
}) {
    if (forcedBid || !recommendedBid || recommendedBid.token !== 'PASS' || !currentTurn || !Array.isArray(auctionHistory) || auctionHistory.length < 2) {
        return { recommendedBid, explanation };
    }

    const alreadyBidContract = auctionHistory.some(e => e?.position === currentTurn && /^[1-7]/.test(e?.bid?.token || ''));
    if (alreadyBidContract) return { recommendedBid, explanation };

    const partnerSeat = partnerOf(currentTurn);
    const partnerLast = auctionHistory.slice().reverse().find(e => e?.position === partnerSeat && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
    if (!partnerLast) return { recommendedBid, explanation };

    const partnerTok = partnerLast.bid.token;
    const partnerSuit = partnerTok.slice(-1);
    const handSpades = hand?.lengths?.S || 0;
    const handHearts = hand?.lengths?.H || 0;
    const hcp = typeof hand?.hcp === 'number' ? hand.hcp : 0;
    const oppSeats = (currentTurn === 'N' || currentTurn === 'S') ? ['E', 'W'] : ['N', 'S'];
    const opponentIntervened = auctionHistory.some(e => oppSeats.includes(e?.position) && /^[1-7](C|D|H|S|NT)$/.test(e?.bid?.token || ''));
    const requiredLen = opponentIntervened ? 5 : 4;
    const totalPoints = (typeof computeTotalPointsFn === 'function') ? computeTotalPointsFn(hand) : hcp;
    const partnerOpenedMinor = partnerSuit === 'C' || partnerSuit === 'D';
    const partnerOpenedHeart = partnerSuit === 'H';
    const minPointsForLevel = (lvl) => (lvl >= 2 ? 10 : 6);
    const canBidSpades = (
        partnerSuit !== 'S' &&
        handSpades >= requiredLen &&
        totalPoints >= minPointsForLevel(1) &&
        (
            partnerOpenedMinor ||
            partnerOpenedHeart
        )
    );
    const canBidHearts = (!partnerOpenedHeart && partnerSuit !== 'H' && handHearts >= requiredLen && totalPoints >= minPointsForLevel(1) && partnerOpenedMinor);

    let guardedBid = null;
    let guardedExplanation = explanation;
    if (canBidSpades) {
        guardedBid = { token: '1S' };
        guardedExplanation = partnerOpenedHeart
            ? `1S response: ${requiredLen}+ spades and 6+ HCP over partner's 1H (show major instead of passing${opponentIntervened ? ' after interference' : ''})`
            : `1S response: ${requiredLen}+ spades and 6+ HCP (show major instead of passing${opponentIntervened ? ' after interference' : ''})`;
    } else if (canBidHearts && partnerOpenedMinor) {
        guardedBid = { token: '1H' };
        guardedExplanation = `1H response: ${requiredLen}+ hearts and 6+ HCP (show major instead of passing${opponentIntervened ? ' after interference' : ''})`;
    } else if (partnerOpenedMinor && !opponentIntervened && handSpades < 4 && handHearts < 4) {
        if (hcp >= 5 && hcp <= 10) {
            guardedBid = { token: '1NT' };
            guardedExplanation = '1NT response: 5-10 HCP, no 4-card major over partner’s minor';
        } else if (hcp >= 11 && hcp <= 12) {
            guardedBid = { token: '2NT' };
            guardedExplanation = '2NT response: 11-12 HCP, no 4-card major over partner’s minor';
        } else if (hcp >= 13 && hcp <= 14) {
            guardedBid = { token: '3NT' };
            guardedExplanation = '3NT response: 13-14 HCP, no 4-card major over partner’s minor';
        }
    }

    if (guardedBid && typeof isValidSystemBid === 'function' && !isValidSystemBid(guardedBid.token, currentTurn)) {
        guardedBid = null;
    }

    if (guardedBid) {
        return { recommendedBid: guardedBid, explanation: guardedExplanation };
    }
    return { recommendedBid, explanation };
}

function applyOvercallLengthGuard({
    recommendedBid,
    explanation,
    forcedBid,
    currentTurn,
    auctionHistory,
    hand,
    isOpponentPosition
}) {
    if (forcedBid || !recommendedBid || !/^[1-2][CDHS]$/.test(recommendedBid.token)) {
        return { recommendedBid, explanation };
    }
    if (!currentTurn || !Array.isArray(auctionHistory)) {
        return { recommendedBid, explanation };
    }

    const firstContract = auctionHistory.find(e => /^[1-7]/.test(e?.bid?.token || ''));
    const ourSideHasContract = auctionHistory.some(e => /^[1-7]/.test(e?.bid?.token || '') && sameSide(e.position, currentTurn));
    const weHaveActed = auctionHistory.some(e => sameSide(e.position, currentTurn) && /^[1-7]/.test(e?.bid?.token || ''));
    const overcallingOppener = firstContract && typeof isOpponentPosition === 'function' && isOpponentPosition(firstContract.position, currentTurn) && !ourSideHasContract && !weHaveActed;

    if (!overcallingOppener) return { recommendedBid, explanation };

    const suit = recommendedBid.token.replace(/^[1-2]/, '');
    const openingSuit = firstContract ? (firstContract.bid?.token || '').replace(/^[1-7]/, '') : null;
    // Skip length guard for cue-bids of opener's suit (e.g., Michaels)
    if (openingSuit && suit === openingSuit) {
        return { recommendedBid, explanation };
    }

    const suitLen = (hand?.lengths && hand.lengths[suit]) || 0;
    const minLen = 5;
    if (suitLen < minLen) {
        return {
            recommendedBid: { token: 'PASS' },
            explanation: `Pass (need ${minLen}+ cards to overcall ${recommendedBid.token})`
        };
    }
    return { recommendedBid, explanation };
}

function applyTwoLevelFreeBidGuard({
    recommendedBid,
    explanation,
    forcedBid,
    currentTurn,
    auctionHistory,
    hand
}) {
    if (forcedBid || !recommendedBid || !currentTurn || !Array.isArray(auctionHistory)) {
        return { recommendedBid, explanation };
    }

    const tok = recommendedBid.token || '';
    const isTwoLevelSuit = /^[2][CDHS]$/.test(tok);
    if (!isTwoLevelSuit) return { recommendedBid, explanation };

    const hcp = typeof hand?.hcp === 'number' ? hand.hcp : 0;
    const sideTag = (s) => (s === 'N' || s === 'S') ? 'NS' : 'EW';
    const sameSideAsCurrent = (seat) => seat && sideTag(seat) === sideTag(currentTurn);

    const havePriorPass = auctionHistory.some(e => e?.position === currentTurn && (e?.bid?.token || '') === 'PASS');
    const partnerLastContract = auctionHistory.slice().reverse().find(e => e && e.position !== currentTurn && sameSideAsCurrent(e.position) && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
    const partnerSuit = partnerLastContract ? partnerLastContract.bid.token.replace(/^[1-7]/, '') : null;
    const ourSuit = tok.replace(/^[1-7]/, '');
    const support = hand?.lengths ? (hand.lengths[partnerSuit] || 0) : 0;
    const isRaiseOfPartnerSuit = !!partnerSuit && ourSuit === partnerSuit;

    if (havePriorPass && partnerLastContract && hcp <= 7) {
        return {
            recommendedBid: { token: 'PASS' },
            explanation: 'Pass - insufficient values to introduce a new suit at the two-level after passing earlier'
        };
    }

    const partnerLastAction = auctionHistory.slice().reverse().find(e => e && e.position !== currentTurn && sameSideAsCurrent(e.position) && e?.bid?.token && e.bid.token !== 'PASS');
    if (partnerLastAction && hcp < 8) {
        // Allow modest two-level raises of partner's suit with at least 3-card support and 6+ HCP
        if (isRaiseOfPartnerSuit && support >= 3 && hcp >= 6) {
            return { recommendedBid, explanation };
        }
        return {
            recommendedBid: { token: 'PASS' },
            explanation: 'Pass - need stronger values for a free two-level suit bid'
        };
    }

    return { recommendedBid, explanation };
}

function stopAuctionConsoleCapture() {
    try {
        if (!__originalConsole) return;
        console.log = __originalConsole.log;
        console.info = __originalConsole.info;
        console.warn = __originalConsole.warn;
        console.error = __originalConsole.error;
        console.debug = __originalConsole.debug;
        __originalConsole = null;
    } catch (e) {
        try { console.warn('stopAuctionConsoleCapture failed', e); } catch (_) { }
    }
}

// Vulnerability defaults: None (ns=false, ew=false)
let vulnerability = { ns: false, ew: false };

// Convention UI state containers (must be declared for module scope)
let availableConventions = {};
let conventionCategories = {};
let enabledConventions = {};
let practiceConventions = [];
let selectedPracticeConventions = {};
let mutuallyExclusiveGroups = [];

function initializeSystem() {
    try {
        // Render General Settings immediately so static notes are visible without waiting
        try { createGeneralSettingsSection(); } catch (_) { }

        // Ensure engine is loaded; if not yet available, retry shortly
        if (!window || typeof window.SAYCBiddingSystem !== 'function') {
            console.warn('Bidding system not ready yet; retrying init...');
            setTimeout(initializeSystem, 300);
            return;
        }

        // Create engine instance once
        if (!system) {
            system = new window.SAYCBiddingSystem();
            systemReady = true;
        }

        // Build conventions UI and apply any persisted settings
        (async () => {
            try {
                // --- Load the bidding model ---
                pageLog('Initializing bidding model...');
                try {
                    await loadBiddingModel('./models/bid_rl_model/model.json', './bid_tokens.json');
                    pageLog('Bidding model initialized successfully.');
                } catch (error) {
                    console.error('Failed to initialize bidding model:', error);
                }
                // --- End model loading ---

                await initializeConventionUI();
                // Apply persisted General Settings to engine config if present
                try {
                    const gs = loadPersistedGeneralSettings();
                    if (gs) applyGeneralSettingsToConfig(gs);
                } catch (_) { }
                // Persist a snapshot after initialization to keep store current
                try { saveGeneralSettings(); } catch (_) { }
                try { saveEnabledConventions(); } catch (_) { }
            } catch (e) {
                console.warn('Convention UI initialization failed (continuing):', e?.message || e);
            }
        })();

        // Set default dealer/vulnerability overlays once controls are present
        try { updateTableOverlays(); } catch (e) { }
        // Hide the Hint button by default so it does not appear next to Start Auction
        try {
            const hb = document.getElementById('hintBtn');
            if (hb) hb.style.display = 'none';
        } catch (_) { }
        // Keep overlays in sync when user changes Dealer/Vulnerability dropdowns
        try {
            const dealerSel = document.getElementById('dealer');
            const vulnSel = document.getElementById('vulnerability');
            if (dealerSel) dealerSel.addEventListener('change', () => { try { updateTableOverlays(); } catch (_) { } });
            if (vulnSel) vulnSel.addEventListener('change', () => { try { updateTableOverlays(); } catch (_) { } });
        } catch (_) { }

        // Generate an initial random deal and show auction setup
        try {
            resetAuctionForNewDeal();
            generateBasicRandomHands();
            displayHands();
            showAuctionSetup();
            // Ensure generation toolbar reflects default mode
            try { setGenerationMode('random'); } catch (_) { }
            // Hide loading indicator now that the UI is ready (fade-out then remove)
            try {
                const li = document.getElementById('loadingIndicator');
                if (li) {
                    li.classList.add('fade-out');
                    setTimeout(() => { try { li.style.display = 'none'; } catch (_) { } }, 280);
                }
            } catch (_) { }
            // Attach Download Log button handler if present
            try {
                const dl = document.getElementById('playDownloadLogBtn');
                if (dl) {
                    dl.addEventListener('click', () => {
                        try { downloadPlayLog(); } catch (e) { console.warn('downloadPlayLog failed', e); }
                    });
                }
            } catch (_) { }
            // Attach Auction download button handler if present
            try {
                const ad = document.getElementById('auctionDownloadBtn');
                if (ad) {
                    ad.addEventListener('click', () => {
                        try { downloadAuctionLog(); } catch (e) { console.warn('downloadAuctionLog failed', e); }
                    });
                }
            } catch (_) { }
        } catch (e) {
            console.warn('Initial deal generation failed:', e?.message || e);
        }
    } catch (err) {
        console.error('initializeSystem failed:', err);
    }
}

// Expose initializer in browser and jsdom/test environments
try {
    if (typeof window !== 'undefined') {
        window.initializeSystem = initializeSystem;
        // Test-only hooks to manipulate internal state safely in jsdom
        try {
            Object.defineProperty(window, '__setCurrentTurnForTests', {
                value: function (seat) { currentTurn = seat; },
                writable: false,
                enumerable: false
            });
            Object.defineProperty(window, '__getAuctionHistoryForTests', {
                value: function () { return Array.isArray(auctionHistory) ? auctionHistory.slice() : []; },
                writable: false,
                enumerable: false
            });
            Object.defineProperty(window, '__getCurrentAuctionForTests', {
                value: function () { return Array.isArray(currentAuction) ? currentAuction.slice() : []; },
                writable: false,
                enumerable: false
            });
        } catch (_) { /* ignore */ }
    }
} catch (_) { /* no-op */ }
// getConventionExplanation is defined later; keep only one definition.
function generateFromManualHands() {
    try {
        // Read manual suit inputs for South and compute total cards entered
        const spades = document.getElementById('spadesInput')?.value?.trim() || '';
        const hearts = document.getElementById('heartsInput')?.value?.trim() || '';
        const diamonds = document.getElementById('diamondsInput')?.value?.trim() || '';
        const clubs = document.getElementById('clubsInput')?.value?.trim() || '';
        const totalCards = (spades + hearts + diamonds + clubs).replace(/\s+/g, '').length;
        try {
            const cc = document.getElementById('cardCount');
            if (cc) cc.textContent = `Cards: ${totalCards}/13`;
        } catch (_) { }
        if (totalCards !== 13) {
            showError(`Hand must have exactly 13 cards. Current: ${totalCards}`);
            return;
        }

        // Validate the suit inputs (check for errors)
        pageLog('Running validation...');
        validateSuitInput(); // This will update the UI and show any errors

        // Check if there are any validation errors displayed
        const errorDiv = document.getElementById('handValidationError');
        if (errorDiv.textContent.trim() !== '') {
            showError('Please fix the errors in your hand entry: ' + errorDiv.textContent);
            return;
        }

        pageLog('Validation passed, continuing...');

        // Create the hand string for South in the format "spades hearts diamonds clubs"
        // Each suit must be represented, use empty string for void suits
        const suitStrings = [
            spades || '',
            hearts || '',
            diamonds || '',
            clubs || ''
        ];
        const southHandString = suitStrings.join(' ');
        pageLog('South hand string:', southHandString);

        // Create South's hand
        pageLog('Creating South hand with string:', southHandString);
        const southHand = new window.Hand(southHandString);
        pageLog('South hand created:', southHand);
        currentHands['S'] = southHand;

        // Track used cards from South's hand
        const usedCards = [];
        ['S', 'H', 'D', 'C'].forEach(suit => {
            if (southHand.suitBuckets[suit]) {
                southHand.suitBuckets[suit].forEach(card => {
                    // Store as string in same format as deck (rank + suit)
                    usedCards.push(card.rank + suit);
                });
            }
        });

        pageLog('South hand created, used cards:', usedCards.length, usedCards);

        // Generate remaining hands randomly for North, East, West
        const deck = createDeck();
        const availableCards = deck.filter(deckCard => {
            return !usedCards.includes(deckCard);
        });

        shuffleDeck(availableCards);

        // Generate North, East, West hands
        const positions = ['N', 'E', 'W'];
        let cardIndex = 0;

        positions.forEach(pos => {
            const handCards = availableCards.slice(cardIndex, cardIndex + 13);
            currentHands[pos] = new window.Hand(convertCardsToHandString(handCards));
            cardIndex += 13;
        });

        pageLog('All hands generated successfully');
        pageLog('Current hands:', currentHands);

        pageLog('Calling displayHands()...');
        displayHands();
        pageLog('Calling showAuctionSetup()...');
        showAuctionSetup();
        // Auto-switch to Auction tab after generating from manual input
        try { switchTab('auction'); } catch (e) { console.warn('Could not switch to auction tab:', e); }
        pageLog('Manual hand generation completed');

    } catch (error) {
        console.error('Error in generateFromManualHands:', error);
        showError('Error generating hands: ' + error.message);
    }
}

function generateWithConstraints() {
    pageLog('generateWithConstraints called');

    try {
        // Cancel any in-progress auction before creating a new deal
        resetAuctionForNewDeal();

        // Check if system is ready
        if (!systemReady || !system) {
            console.error('System not ready yet');
            showError('System not ready. Please wait for initialization to complete.');
            return;
        }

        // Get constraint values from the UI
        const constraints = getConstraints();
        pageLog('Constraints:', constraints);

        // This is a simplified version - full constraint handling would be complex
        // For now, generate random hands and check if they approximately match constraints
        let attempts = 0;
        let success = false;

        while (attempts < 100 && !success) {
            // Generate basic random hands without calling generateRandomHands to avoid recursion
            const deck = createDeck();
            shuffleDeck(deck);

            // Convert deck cards to suit-separated format for Hand constructor
            currentHands.N = new window.Hand(convertCardsToHandString(deck.slice(0, 13)));
            currentHands.E = new window.Hand(convertCardsToHandString(deck.slice(13, 26)));
            currentHands.S = new window.Hand(convertCardsToHandString(deck.slice(26, 39)));
            currentHands.W = new window.Hand(convertCardsToHandString(deck.slice(39, 52)));

            // Check if hands roughly match constraints
            success = checkConstraints(constraints);
            attempts++;
        }

        if (!success) {
            alert('Could not generate hands matching constraints after 100 attempts. Try looser constraints.');
            pageLog('Failed to match constraints after 100 attempts');
        } else {
            pageLog(`Successfully generated hands with constraints in ${attempts} attempts`);
        }

        displayHands();
        showAuctionSetup();
        // Auto-switch to Auction tab after constrained generation
        try { switchTab('auction'); } catch (e) { console.warn('Could not switch to auction tab:', e); }

    } catch (error) {
        console.error('Error generating with constraints:', error);
        showError('Error generating with constraints: ' + error.message);
    }
}

function generateConstrainedHands() {
    generateWithConstraints();
}

// Switch between Random / Manual / Constraints modes in the Hand Generation tab
function setGenerationMode(mode) {
    try {
        generationMode = mode;
        const manual = document.getElementById('manualMode');
        const constraint = document.getElementById('constraintMode');
        const genBtn = document.getElementById('generateBtn'); // Generate Random Hands

        if (manual) manual.style.display = (mode === 'manual') ? 'block' : 'none';
        if (constraint) constraint.style.display = (mode === 'constraints') ? 'block' : 'none';

        // Toolbar buttons behavior:
        // - Random: show "Generate Random Hands"
        // - Manual/Constraints: hide toolbar button; each mode has its own generate action
        if (mode === 'random') {
            if (genBtn) genBtn.style.display = 'inline-block';
        } else {
            if (genBtn) genBtn.style.display = 'none';
        }

        // Clear manual errors when leaving manual mode
        if (mode !== 'manual') {
            try {
                const err = document.getElementById('handValidationError');
                const cc = document.getElementById('cardCount');
                if (err) err.textContent = '';
                if (cc) cc.textContent = 'Cards: 0/13';
                ['spadesInput', 'heartsInput', 'diamondsInput', 'clubsInput'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el && el.classList) el.classList.remove('is-invalid');
                });
            } catch (_) { }
        }
    } catch (e) {
        console.warn('setGenerationMode failed:', e?.message || e);
    }
}

function getConstraints() {
    // Read constraint values from the UI inputs
    const positions = ['north', 'east', 'south', 'west'];
    const constraints = {};

    positions.forEach(position => {
        constraints[position] = {
            hcp: { min: getInputValue(`${position}HcpMin`), max: getInputValue(`${position}HcpMax`) },
            spades: { min: getInputValue(`${position}SpadesMin`), max: getInputValue(`${position}SpadesMax`) },
            hearts: { min: getInputValue(`${position}HeartsMin`), max: getInputValue(`${position}HeartsMax`) },
            diamonds: { min: getInputValue(`${position}DiamondsMin`), max: getInputValue(`${position}DiamondsMax`) },
            clubs: { min: getInputValue(`${position}ClubsMin`), max: getInputValue(`${position}ClubsMax`) }
        };
    });

    return constraints;
}

function getInputValue(inputId) {
    const input = document.getElementById(inputId);
    if (input && input.value.trim() !== '') {
        return parseInt(input.value);
    }
    return null;
}

// Basic UI error helper (fallbacks to alert if no target container)
function showError(message) {
    try {
        const el = document.getElementById('globalError') || document.getElementById('auctionStatus');
        if (el) {
            el.textContent = String(message || 'An error occurred');
            el.className = 'alert alert-danger';
            return;
        }
    } catch (_) { }
    // Fallback
    try { alert(message); } catch (_) { }
}

// Validate manual hand entry for South (inputs: southSpades/Hearts/Diamonds/Clubs)
function validateSuitInput() {
    const errEl = document.getElementById('handValidationError');
    const spEl = document.getElementById('spadesInput');
    const heEl = document.getElementById('heartsInput');
    const diEl = document.getElementById('diamondsInput');
    const clEl = document.getElementById('clubsInput');
    const inputs = [spEl, heEl, diEl, clEl].filter(Boolean);
    const values = {
        S: (spEl?.value || '').toUpperCase().replace(/\s+/g, ''),
        H: (heEl?.value || '').toUpperCase().replace(/\s+/g, ''),
        D: (diEl?.value || '').toUpperCase().replace(/\s+/g, ''),
        C: (clEl?.value || '').toUpperCase().replace(/\s+/g, '')
    };
    // Allow '-' to denote voids; remove them for validation length counting
    Object.keys(values).forEach(k => { values[k] = values[k].replace(/-/g, ''); });

    const validRanks = new Set(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);
    const errors = [];

    // Clear previous input error styling
    inputs.forEach(el => el.classList && el.classList.remove('is-invalid'));

    // Per-suit validation: only valid ranks, no duplicates within a suit
    const suitOrder = ['S', 'H', 'D', 'C'];
    suitOrder.forEach(suit => {
        const txt = values[suit] || '';
        const seen = new Set();
        for (const ch of txt) {
            if (!validRanks.has(ch)) {
                errors.push(`Invalid character "${ch}" in ${suitName(suit)}.`);
                markInvalid(suit);
            } else if (seen.has(ch)) {
                errors.push(`Duplicate rank "${ch}" in ${suitName(suit)}.`);
                markInvalid(suit);
            } else {
                seen.add(ch);
            }
        }
    });

    // Total card count across all suits must be exactly 13
    const total = (values.S.length + values.H.length + values.D.length + values.C.length);
    try {
        const cc = document.getElementById('cardCount');
        if (cc) cc.textContent = `Cards: ${total}/13`;
    } catch (_) { }
    if (total !== 13) {
        errors.push(`Hand must have exactly 13 cards. Current: ${total}.`);
        // Mark all inputs softly since count spans suits
        inputs.forEach(el => el.classList && el.classList.add('is-invalid'));
    }

    if (errEl) errEl.textContent = errors.join(' ');
    return errors.length === 0;

    function suitName(c) {
        return c === 'S' ? 'spades' : c === 'H' ? 'hearts' : c === 'D' ? 'diamonds' : 'clubs';
    }
    function markInvalid(suit) {
        const map = { S: spEl, H: heEl, D: diEl, C: clEl };
        const el = map[suit];
        if (el && el.classList) el.classList.add('is-invalid');
    }
}

function checkConstraints(constraints) {
    const positions = ['north', 'east', 'south', 'west'];
    const hands = [currentHands.N, currentHands.E, currentHands.S, currentHands.W];

    for (let i = 0; i < positions.length; i++) {
        const position = positions[i];
        const hand = hands[i];
        const constraint = constraints[position];

        if (!hand) continue;

        // Check HCP constraint
        if (constraint.hcp.min !== null && hand.hcp < constraint.hcp.min) {
            return false;
        }
        if (constraint.hcp.max !== null && hand.hcp > constraint.hcp.max) {
            return false;
        }

        // Check suit length constraints
        const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
        const suitCodes = ['S', 'H', 'D', 'C'];

        for (let j = 0; j < suits.length; j++) {
            const suitLength = hand.lengths[suitCodes[j]];
            if (constraint[suits[j]].min !== null && suitLength < constraint[suits[j]].min) {
                return false;
            }
            if (constraint[suits[j]].max !== null && suitLength > constraint[suits[j]].max) {
                return false;
            }
        }
    }

    return true;
}

// Hand Display Functions
function toggleHandVisibility(mode) {
    handVisibility = mode;

    // Update button states
    document.getElementById('southOnlyBtn').classList.toggle('btn-light', mode === 'south');
    document.getElementById('southOnlyBtn').classList.toggle('btn-outline-light', mode !== 'south');
    document.getElementById('allHandsBtn').classList.toggle('btn-light', mode === 'all');
    document.getElementById('allHandsBtn').classList.toggle('btn-outline-light', mode !== 'all');

    // Show/hide hands - South hand is always visible
    const showAll = mode === 'all';
    document.getElementById('southHand').style.display = 'block'; // Always show South
    document.getElementById('northHand').style.display = showAll ? 'block' : 'none';
    document.getElementById('eastHand').style.display = showAll ? 'block' : 'none';
    document.getElementById('westHand').style.display = showAll ? 'block' : 'none';
}

let otherHandsVisible = false;

function toggleOtherHands() {
    otherHandsVisible = !otherHandsVisible;
    const toggleBtn = document.getElementById('toggleHandsBtn');
    const handsGrid = document.querySelector('.hands-grid');

    if (otherHandsVisible) {
        // Show all hands
        document.getElementById('northHand').style.display = 'block';
        document.getElementById('eastHand').style.display = 'block';
        document.getElementById('westHand').style.display = 'block';
        toggleBtn.textContent = 'Hide Other Hands';
        if (handsGrid) handsGrid.classList.remove('solo-south');
    } else {
        // Hide other hands, keep South visible
        document.getElementById('northHand').style.display = 'none';
        document.getElementById('eastHand').style.display = 'none';
        document.getElementById('westHand').style.display = 'none';
        toggleBtn.textContent = 'Show Other Hands';
        if (handsGrid) handsGrid.classList.add('solo-south');
    }
}

function displayHands() {
    pageLog('displayHands called');
    pageLog('currentHands.S:', currentHands.S);

    if (!currentHands.S) {
        console.error('No South hand to display');
        return;
    }

    pageLog('Displaying all hands...');

    // Display all hands
    displaySingleHand('north', currentHands.N);
    displaySingleHand('east', currentHands.E);
    displaySingleHand('south', currentHands.S);
    displaySingleHand('west', currentHands.W);

    // Show game layout
    const gameLayout = document.getElementById('gameLayout');
    if (gameLayout) {
        gameLayout.style.display = 'grid';
        pageLog('Game layout made visible');
    } else {
        console.error('gameLayout element not found');
    }

    // Clear any previous "Auction Ended" banner or status from a prior deal
    try {
        const auctionGrid = document.querySelector('.auction-grid');
        if (auctionGrid) {
            auctionGrid.querySelectorAll('.auction-result').forEach(el => el.remove());
        }
        const auctionStatus = document.getElementById('auctionStatus');
        if (auctionStatus) {
            // Reset to the default prompt shown on initial load
            auctionStatus.textContent = 'Click "Start Auction" to begin bidding.';
            auctionStatus.className = 'alert alert-info';
        }
    } catch (cleanupErr) {
        console.warn('Could not clear previous auction end state:', cleanupErr?.message || cleanupErr);
    }

    // On a new deal, ensure dealer/vulnerability controls are unlocked even if a prior auction was active
    try { setDealerVulnerabilityDisabled(false); } catch (e) { }

    // Show start auction button
    const startAuctionBtn = document.getElementById('startAuctionBtn');
    if (startAuctionBtn) {
        startAuctionBtn.style.display = 'inline-block';
    }

    // Set initial visibility based on General Settings preference (default: show all)
    const persistedGS = (function () { try { return loadPersistedGeneralSettings(); } catch (_) { return null; } })();
    const showAllByDefault = (persistedGS && typeof persistedGS.show_all_hands_by_default === 'boolean') ? persistedGS.show_all_hands_by_default : true;
    otherHandsVisible = !!showAllByDefault;
    // South is always visible
    document.getElementById('southHand').style.display = 'block';
    document.getElementById('northHand').style.display = otherHandsVisible ? 'block' : 'none';
    document.getElementById('eastHand').style.display = otherHandsVisible ? 'block' : 'none';
    document.getElementById('westHand').style.display = otherHandsVisible ? 'block' : 'none';
    // Toggle layout class to avoid overlay overlapping when only South is shown
    try {
        const handsGrid = document.querySelector('.hands-grid');
        if (handsGrid) {
            handsGrid.classList.toggle('solo-south', !otherHandsVisible);
        }
    } catch (_) { }

    const toggleBtn = document.getElementById('toggleHandsBtn');
    if (toggleBtn) {
        toggleBtn.textContent = otherHandsVisible ? 'Hide Other Hands' : 'Show Other Hands';
    }

    // Update center overlay badges based on current selects
    try { updateTableOverlays(); } catch (e) { }

    // Before any auction starts, keep bid pad disabled by default
    try { setAllBidButtonsDisabled(true); } catch (_) { }

    pageLog('displayHands completed');
}

function displaySingleHand(position, hand) {
    pageLog(`displaySingleHand called for ${position}`, hand);

    if (!hand) {
        console.error(`No hand provided for ${position}`);
        return;
    }

    const contentElement = document.getElementById(`${position}HandContent`);
    if (!contentElement) {
        console.error(`Content element for ${position} not found`);
        return;
    }

    // Build the hand display HTML
    const suitSymbols = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
    const suitColors = { 'S': '#000', 'H': '#d63031', 'D': '#d63031', 'C': '#000' };

    let handHTML = '';
    ['S', 'H', 'D', 'C'].forEach(suitCode => {
        const cards = hand.suitBuckets[suitCode] ?
            hand.suitBuckets[suitCode].map(card => card.rank).join(' ') : '-';

        handHTML += `
            <div class="hand-suit">
                <span class="suit-symbol" style="color: ${suitColors[suitCode]}">${suitSymbols[suitCode]}</span>
                <span class="suit-cards">${cards}</span>
            </div>
        `;
    });

    // Calculate distribution points according to General Settings preference
    let distPoints = 0;
    try {
        const gs = loadPersistedGeneralSettings();
        const dpType = (gs && gs.dp_display_type) ? gs.dp_display_type : 'shortness';
        if (dpType === 'length') {
            distPoints = calculateLengthPoints(hand);
        } else {
            distPoints = calculateShortnessPoints(hand);
        }
    } catch (_) {
        distPoints = calculateShortnessPoints(hand);
    }

    // Add HCP and DP display
    handHTML += `<div style="margin-top: 10px; font-size: 0.9em; color: #3498db;">HCP: ${hand.hcp} | DP: ${distPoints}</div>`;

    contentElement.innerHTML = handHTML;
    pageLog(`Displayed hand for ${position} with ${hand.hcp} HCP and ${distPoints} DP`);
}

function calculateLengthPoints(hand) {
    // Calculate length points: 1 point for 5th card, 2 for 6th, etc.
    let distPoints = 0;
    const lengths = [hand.lengths.S, hand.lengths.H, hand.lengths.D, hand.lengths.C];

    lengths.forEach(length => {
        if (length >= 5) {
            distPoints += (length - 4); // 1 point for 5th card, 2 for 6th, etc.
        }
    });

    return distPoints;
}

// Update center overlay badges for dealer and vulnerability
function updateTableOverlays() {
    const dealerSel = document.getElementById('dealer');
    const vulnSel = document.getElementById('vulnerability');
    const dealerBadge = document.getElementById('dealerBadge');
    const vulnBadge = document.getElementById('vulnBadge');
    if (!dealerSel || !vulnSel || !dealerBadge || !vulnBadge) return;

    const dealerMap = { N: 'North', E: 'East', S: 'South', W: 'West' };
    const vulnMap = { none: 'None', ns: 'N-S', ew: 'E-W', both: 'Both' };

    const dVal = dealerSel.value || 'S';
    const vVal = vulnSel.value || 'none';

    dealerBadge.textContent = `Dealer: ${dealerMap[dVal] || dVal}`;
    vulnBadge.textContent = `Vul: ${vulnMap[vVal] || vVal}`;

    // Reset and apply vuln color class
    vulnBadge.classList.remove('vul-none', 'vul-ns', 'vul-ew', 'vul-both');
    vulnBadge.classList.add(`vul-${vVal}`);
}

// Fully reset any in-progress auction when starting a new deal
function resetAuctionForNewDeal() {
    try {
        // Flags and state
        auctionActive = false;
        auctionHistory = [];
        currentAuction = [];
        currentTurn = null;

        // Engine state (if present)
        try {
            if (system && typeof system === 'object') {
                if (system.currentAuction) system.currentAuction = null;
            }
        } catch (_) { }

        // UI cleanup
        const biddingInterface = document.getElementById('biddingInterface');
        if (biddingInterface) biddingInterface.style.display = 'none';

        const auctionBids = document.getElementById('auctionBids');
        if (auctionBids) auctionBids.innerHTML = '';

        const explanationsList = document.getElementById('explanationsList');
        if (explanationsList) explanationsList.innerHTML = '';

        const auctionStatus = document.getElementById('auctionStatus');
        if (auctionStatus) {
            auctionStatus.textContent = 'Click "Start Auction" to begin bidding.';
            auctionStatus.className = 'alert alert-info';
        }

        const startAuctionBtn = document.getElementById('startAuctionBtn');
        if (startAuctionBtn) startAuctionBtn.style.display = 'inline-block';

        // Remove any prior "auction ended" banner rows, if still present
        try {
            const auctionGrid = document.querySelector('.auction-grid');
            if (auctionGrid) auctionGrid.querySelectorAll('.auction-result').forEach(el => el.remove());
        } catch (_) { }

        // Ensure controls are enabled so user can adjust before next auction
        try { setDealerVulnerabilityDisabled(false); } catch (_) { }

        // Restore Hint button default state (red, invokes recommendation) but keep it hidden until auction starts
        try {
            const hintBtn = document.getElementById('hintBtn');
            if (hintBtn) {
                hintBtn.textContent = 'Hint';
                hintBtn.classList.remove('secondary', 'success');
                hintBtn.classList.add('danger');
                hintBtn.setAttribute('onclick', 'getRecommendedBid()');
                // Keep hidden pre-auction so it does not appear next to Start Auction
                hintBtn.style.display = 'none';
            }
        } catch (_) { }
    } catch (e) {
        console.warn('resetAuctionForNewDeal encountered an issue:', e?.message || e);
    }
}

// Wrapper used by inline handlers to fully reset the auction state
function resetAuction() {
    try { stopAuctionConsoleCapture(); } catch (_) { }
    try { resetAuctionForNewDeal(); } catch (e) { console.warn('resetAuction failed:', e?.message || e); }
    try { updatePlayTabState(); } catch (_) { }
}

// Enable/disable Dealer and Vulnerability controls during an active auction
function setDealerVulnerabilityDisabled(disabled) {
    try {
        const dealerSel = document.getElementById('dealer');
        const vulnSel = document.getElementById('vulnerability');
        if (dealerSel) dealerSel.disabled = !!disabled;
        if (vulnSel) vulnSel.disabled = !!disabled;
    } catch (e) {
        console.warn('Failed to toggle dealer/vulnerability controls:', e?.message || e);
    }
}

// Auction Management Functions
function showAuctionSetup() {
    const auctionSetupElement = document.getElementById('auctionSetup');
    if (auctionSetupElement) {
        auctionLog('showAuctionSetup called');
        auctionSetupElement.style.display = 'block';
        auctionLog('Auction setup made visible');
    } else {
        // Optional container is not present on some layouts; treat as no-op
        pageLog('auctionSetup element not found (optional)');
    }
}

function startAuction() {
    auctionLog('startAuction called');

    // Force switch to Practice Bids tab
    showTab('practice-bids');
    auctionLog('Switched to Practice Bids tab');

    // Ensure any previous "Auction Ended" indicators are cleared before starting
    try {
        const auctionGrid = document.querySelector('.auction-grid');
        if (auctionGrid) {
            auctionGrid.querySelectorAll('.auction-result').forEach(el => el.remove());
        }
    } catch (cleanupErr) {
        console.warn('Could not clear previous auction result row:', cleanupErr?.message || cleanupErr);
    }

    // Show auction content
    const auctionContent = document.getElementById('auctionContent');
    if (auctionContent) {
        auctionContent.style.display = 'block';
        auctionLog('Auction content made visible');
    } else {
        console.error('auctionContent element not found');
    }

    // Immediately show bidding interface if dealer is South
    const dealerSelEl = document.getElementById('dealer');
    const dealerVal = (dealerSelEl && dealerSelEl.value) ? dealerSelEl.value : 'S';
    if (dealerVal === 'S') {
        auctionLog('Dealer is South - pre-showing bidding interface');
        const biddingInterface = document.getElementById('biddingInterface');
        if (biddingInterface) {
            biddingInterface.style.display = 'block';
            auctionLog('Pre-showed bidding interface for South dealer');
        }
    }

    // Hide start auction button
    const startAuctionBtn = document.getElementById('startAuctionBtn');
    if (startAuctionBtn) {
        startAuctionBtn.style.display = 'none';
    }

    // Update auction status to show the auction has started
    const auctionStatus = document.getElementById('auctionStatus');
    if (auctionStatus) {
        auctionStatus.textContent = 'Auction in progress...';
        auctionStatus.className = 'alert alert-success';
    } else {
        console.error('auctionStatus element not found');
    }

    // Call the existing auction initialization
    startNewAuction();
}

function startNewAuction() {
    try {
        if (!currentHands.S) {
            alert('Please generate hands first');
            return;
        }

        // Clear prior UI remnants so a restart begins cleanly
        try {
            const auctionBids = document.getElementById('auctionBids');
            if (auctionBids) auctionBids.innerHTML = '';
            const explanationsList = document.getElementById('explanationsList');
            if (explanationsList) explanationsList.innerHTML = '';
            const auctionGrid = document.querySelector('.auction-grid');
            if (auctionGrid) auctionGrid.querySelectorAll('.auction-result').forEach(el => el.remove());
        } catch (_) { }

        // Get dealer and vulnerability settings (default to South/None if unset)
        const dealerEl = document.getElementById('dealer');
        dealer = (dealerEl && dealerEl.value) ? dealerEl.value : 'S';
        // If UI had no value, reflect the default back to the dropdown and overlays
        try {
            if (dealerEl && !dealerEl.value) dealerEl.value = dealer;
            updateTableOverlays();
        } catch (_) { }
        const vulnEl = document.getElementById('vulnerability');
        const vulSetting = (vulnEl && vulnEl.value) ? vulnEl.value : 'none';
        try {
            if (vulnEl && !vulnEl.value) vulnEl.value = 'none';
            updateTableOverlays();
        } catch (_) { }

        // Set vulnerability
        vulnerability.ns = vulSetting === 'ns' || vulSetting === 'both';
        vulnerability.ew = vulSetting === 'ew' || vulSetting === 'both';
        // Ensure Play tab is disabled at the start of a new auction
        try { updatePlayTabState(); } catch (_) { }

        // Initialize auction
        auctionHistory = [];
        currentAuction = [];
        auctionActive = true;
        // Start capturing console output for Auction tab
        try { startAuctionConsoleCapture(); } catch (_) { }
        // Lock Dealer/Vulnerability controls while auction is active
        setDealerVulnerabilityDisabled(true);

        // Initialize bidding system for this auction (human is always South)
        if (typeof system.startAuctionWithDealer !== 'function') {
            // Shim helper: start auction and set dealer rotation
            system.startAuctionWithDealer = function (ourSeat, dealerSeat, vulNS, vulEW) {
                this.startAuction(ourSeat, /*we*/ vulNS, /*they*/ vulEW);
                if (this.currentAuction && typeof this.currentAuction.reseat === 'function') {
                    this.currentAuction.reseat(dealerSeat);
                } else if (this.currentAuction) {
                    this.currentAuction.dealer = dealerSeat;
                }
            };
        }
        system.startAuctionWithDealer('S', dealer, vulnerability.ns, vulnerability.ew);

        // Update auction table headers to show dealer first
        updateAuctionHeaders();

        // Determine starting position (first to bid is the dealer)
        currentTurn = dealer;

        // Ensure Hint button is in Hint mode at auction start
        try {
            const hintBtn = document.getElementById('hintBtn');
            if (hintBtn) {
                hintBtn.textContent = 'Hint';
                hintBtn.classList.remove('secondary', 'success');
                hintBtn.classList.add('danger');
                hintBtn.setAttribute('onclick', 'getRecommendedBid()');
            }
        } catch (_) { }

        // Update UI
        updateAuctionTable();
        updateAuctionStatus();

        // Start bidding sequence
        processTurn();

    } catch (error) {
        console.error('Error starting auction:', error);
        showError('Error starting auction: ' + error.message);
    }
}

function processTurn() {
    if (!auctionActive) return;

    auctionLog(`processTurn called: currentTurn = ${currentTurn}`);

    if (currentTurn === 'S') {
        // Player's turn
        auctionLog('Showing bidding interface for South');

        // Check parent container first
        const auctionContent = document.getElementById('auctionContent');
        auctionLog('auctionContent element:', auctionContent);
        auctionLog('auctionContent display:', auctionContent ? auctionContent.style.display : 'not found');

        const biddingInterface = document.getElementById('biddingInterface');
        auctionLog('biddingInterface element:', biddingInterface);
        auctionLog('biddingInterface display:', biddingInterface ? biddingInterface.style.display : 'not found');

        // Ensure parent is visible
        if (auctionContent) {
            auctionContent.style.display = 'block';
            auctionLog('Ensured auctionContent is visible');
        }

        if (biddingInterface) {
            biddingInterface.style.display = 'block';
            auctionLog('Bidding interface displayed');
        } else {
            console.error('Bidding interface element not found');
        }
        // Re-enable appropriate buttons for user's turn
        updateBidButtons();

        // Debug: Check if buttons are enabled
        const bidButtons = document.querySelectorAll('.bid-button');
        auctionLog('Bid buttons found:', bidButtons.length);
        bidButtons.forEach((btn, index) => {
            if (index < 5) { // Log first 5 buttons
                auctionLog(`Button ${index}: disabled=${btn.disabled}, onclick=${btn.getAttribute('onclick')}`);
            }
        });
    } else {
        // System's turn
        auctionLog(`System turn for ${currentTurn}`);
        const biddingInterface = document.getElementById('biddingInterface');
        if (biddingInterface) {
            biddingInterface.style.display = 'none';
        }
        // Disable all bid buttons while it's not the user's turn
        try { setAllBidButtonsDisabled(true); } catch (_) { }
        setTimeout(() => makeSystemBid(), 1000); // Delay for realism
    }
}

function isPartnerResponse(auctionLength) {
    // Determine if the current bid is from partner or opponent
    // Auction positions: 1=South, 2=West, 3=North, 4=East (if South deals)
    // Partners: South-North (1,3), West-East (2,4)

    if (auctionLength === 1) {
        // Second bid - if South opened, this should be West (opponent)
        // If West opened, this should be North (opponent)
        // Since we're checking after South's 2C, position 2 is West (opponent)
        return false; // Position 2 (West) is opponent to South
    } else if (auctionLength === 2) {
        // Third bid - if South opened, this should be North (partner)
        return true; // Position 3 (North) is partner to South
    } else if (auctionLength === 3) {
        // Fourth bid - if South opened, this should be East (opponent) 
        return false; // Position 4 (East) is opponent to South
    }

    // For longer auctions, use modulo to determine partnership
    // Positions 1,3,5,7... are South/North partnership
    // Positions 2,4,6,8... are West/East partnership
    const position = (auctionLength % 4) + 1;
    return position === 1 || position === 3; // South or North
}

// Debug logging toggles
// Set window.__debugPageLogs or window.__debugAuctionLogs to true to enable ad-hoc logging without code changes.
const DEFAULT_PAGE_DEBUG = false;
const DEFAULT_AUCTION_DEBUG = true;

function pageLog(...args) {
    try {
        const enabled = (typeof window !== 'undefined' && window.__debugPageLogs === true) || DEFAULT_PAGE_DEBUG;
        if (enabled) console.log(...args);
    } catch (_) { /* ignore logging errors */ }
}

function auctionLog(...args) {
    try {
        const enabled = (typeof window !== 'undefined' && window.__debugAuctionLogs === true) || DEFAULT_AUCTION_DEBUG;
        if (!enabled) return;
        const text = args.map(a => {
            try { return (typeof a === 'string') ? a : JSON.stringify(a); } catch (_) { return String(a); }
        }).join(' ').toLowerCase();
        const noisy = [
            'showing bidding interface',
            'auctioncontent',
            'auction content',
            'biddinginterface',
            'interface',
            'element:',
            'display:',
            'bid buttons found',
            'button ',
            'button:',
            'onclick=',
            'updatebidbuttons',
            'ensured auctioncontent',
            'bidding interface displayed',
            'panel elements',
            'panel ',
            'hint button',
            'chevron',
            'showtab',
            'auction setup',
            'auction content made visible'
        ];
        if (noisy.some(k => text.includes(k))) return;
        console.log(...args);
    } catch (_) { /* ignore logging errors */ }
}

function getSeatRelativeDefaultExplanation(seat) {
    return '';
}

function isGenericExplanationLabel(text) {
    if (!text) return true;
    return text === 'Your bid' || text === 'Partner bid' || text === 'Opponent bid' || text === 'Standard bid';
}

function getConventionExplanation(bid, auction, seat = currentTurn) {
    const defaultLabel = getSeatRelativeDefaultExplanation(seat);
    let explanation = defaultLabel;

    // Prefer the engine's explanation when available
    try {
        if (system && typeof system.getExplanationFor === 'function') {
            explanation = system.getExplanationFor(bid, { bids: auction });
        }
    } catch (_) { /* fall back to local reasoning */ }

    // Guard against mislabeling raises and cue bids. Only call it a raise of partner's suit
    // when partner (not us) made the last contract in that suit. If we were the opener in that
    // suit, prefer a neutral label instead of "partner's".
    try {
        const token = bid?.token || '';
        const suit = token.replace(/^[1-7]/, '');
        if (/^[1-7][CDHS]$/.test(token)) {
            const actorSeat = seat || currentTurn || 'S';
            const partnerSeat = partnerOf(actorSeat);
            const history = auctionHistory || [];
            const partnerLastContract = history.slice().reverse().find(entry => {
                const tok = entry?.bid?.token || 'PASS';
                return entry?.position === partnerSeat && tok !== 'PASS' && tok !== 'X' && tok !== 'XX';
            });
            const actorLastContract = history.slice().reverse().find(entry => {
                const tok = entry?.bid?.token || 'PASS';
                return entry?.position === actorSeat && tok !== 'PASS' && tok !== 'X' && tok !== 'XX';
            });
            const partnerSuit = partnerLastContract ? (partnerLastContract.bid.token || '').replace(/^[1-7]/, '') : '';
            const actorSuit = actorLastContract ? (actorLastContract.bid.token || '').replace(/^[1-7]/, '') : '';
            if (partnerSuit && partnerSuit === suit && actorSuit !== suit) {
                const suitNames = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };
                explanation = `Raise to ${token} in partner's ${suitNames[suit] || suit}`;
            }
        }
    } catch (_) { /* best-effort protection against cue-raise mislabels */ }

    return explanation || defaultLabel;
}

// Ensure the explanation aligns with the actual bid token (prevents stale/mismatched labels).
function normalizeExplanationForBid(bid, explanation, auctionCtx = currentAuction, seat = currentTurn) {
    try {
        const token = bid?.token || (bid?.isDouble ? 'X' : bid?.isRedouble ? 'XX' : null);
        if (!token) return explanation;
        const lower = (explanation || '').toLowerCase();

        const tokenIsDouble = token === 'X' || token === 'XX';
        if (!tokenIsDouble && lower.includes('double')) {
            return getConventionExplanation(bid, auctionCtx, seat) || '';
        }

        const denom = token.replace(/^[1-7]/, '');
        const suitWords = {
            C: ['club', 'clubs'],
            D: ['diamond', 'diamonds'],
            H: ['heart', 'hearts'],
            S: ['spade', 'spades']
        };
        const mentionsSuitWord = Object.values(suitWords).flat().some(w => lower.includes(w));
        const mentionsNT = lower.includes('nt') || lower.includes('notrump');

        if (denom === 'NT') {
            if (mentionsSuitWord && !mentionsNT) {
                return getConventionExplanation(bid, auctionCtx, seat) || '';
            }
        } else if (['C', 'D', 'H', 'S'].includes(denom)) {
            const ourWords = suitWords[denom] || [];
            const mentionsOurSuit = ourWords.some(w => lower.includes(w));
            if (mentionsNT || (mentionsSuitWord && !mentionsOurSuit)) {
                return getConventionExplanation(bid, auctionCtx, seat) || '';
            }
        }

        return explanation;
    } catch (_) {
        return explanation;
    }
}

function makeBid(bidString) {
    try {
        if (currentTurn !== 'S') return;

        const bid = new window.Bid(bidString);
        if (!bid.seat) bid.seat = currentTurn;

        // Check if this bid uses a convention
        let explanation = getSeatRelativeDefaultExplanation('S');
        if (bid.conventionUsed) {
            explanation = bid.conventionUsed;
        } else {
            // Check for known conventions based on the bid and auction context
            explanation = getConventionExplanation(bid, currentAuction, 'S');
        }

        // Sanity-check: avoid stale/mismatched labels (e.g., leftover "double" text on suit bids)
        explanation = normalizeExplanationForBid(bid, explanation, currentAuction, 'S');

        auctionHistory.push({
            position: 'S',
            bid: bid,
            explanation: explanation
        });

        currentAuction.push(bid);
        addBidExplanation('S', bid, explanation);

        // Move to next turn
        advanceTurn();
        updateAuctionTable();
        updateAuctionStatus();

        // Check if auction is over
        auctionLog('Human bid - checking if auction is complete...');
        auctionLog('Current auction length:', currentAuction.length);
        auctionLog('Last 3 bids:', currentAuction.slice(-3).map(bid => bid.token || 'PASS'));

        if (isAuctionComplete()) {
            auctionLog('Auction is complete after human bid, ending...');
            endAuction();
        } else {
            auctionLog('Auction continues after human bid...');
            processTurn();
        }

    } catch (error) {
        console.error('Error making bid:', error);
        alert('Error making bid: ' + error.message);
    }
}

function isHigherBid(newBid, lastBid) {
    if (!lastBid) return true;

    // Some test stubs may not populate level/suit on Bid objects; derive from token when missing
    const parseParts = (b) => {
        const tok = (typeof b === 'string') ? b : (b?.token || '');
        const m = /^([1-7])(C|D|H|S|NT)$/.exec(tok);
        if (m) return { level: parseInt(m[1], 10), suit: m[2] };
        // For PASS/X/XX or invalid, return sentinel values
        return { level: Number.NEGATIVE_INFINITY, suit: null };
    };

    const nbLevel = (newBid.level != null) ? newBid.level : parseParts(newBid).level;
    const nbSuit = newBid.suit || parseParts(newBid).suit;
    const lbLevel = (lastBid.level != null) ? lastBid.level : parseParts(lastBid).level;
    const lbSuit = lastBid.suit || parseParts(lastBid).suit;

    // Compare levels first
    if (nbLevel > lbLevel) return true;
    if (nbLevel < lbLevel) return false;

    // Same level - compare suits (C=0, D=1, H=2, S=3, NT=4)
    const suitOrder = { 'C': 0, 'D': 1, 'H': 2, 'S': 3, 'NT': 4 };
    return (suitOrder[nbSuit] || 0) > (suitOrder[lbSuit] || 0);
}

function checkForcedResponse(hand, auction) {
    auctionLog('checkForcedResponse called');
    auctionLog('Auction length:', auction.length);
    auctionLog('First bid:', auction.length > 0 ? auction[0].token : 'none');
    auctionLog('System object:', !!system);
    auctionLog('System conventions:', !!system?.conventions);
    auctionLog('Hand HCP (forced-check):', hand?.hcp);
    auctionLog('Hand lengths (C,D,H,S):', hand?.lengths);
    // Be robust when conventions API is stubbed in tests (isEnabled may be undefined)
    const strong2cOn = !!(system?.conventions?.isEnabled?.('strong_2_clubs', 'opening_bids'));
    auctionLog('Strong 2C enabled:', strong2cOn);

    // Strong 2C forcing response - only for PARTNER, not opponents
    const firstBidIs2C = auction.length >= 1 && auction[0].token === '2C';

    // Determine current seat robustly using dealer and TURN_ORDER when available.
    // Fall back to the original simple position math if dealer/TURN_ORDER are not available.
    let currentSeat = null;
    let isPartnerToOpener = false;
    try {
        const order = (window.Auction && Array.isArray(window.Auction.TURN_ORDER)) ? window.Auction.TURN_ORDER : ['N', 'E', 'S', 'W'];
        const dealerSeat = (typeof dealer !== 'undefined' && dealer) ? dealer : (order[0] || 'S');
        const idx = order.indexOf(dealerSeat) >= 0 ? order.indexOf(dealerSeat) : 0;
        currentSeat = order[(idx + (auction.length || 0)) % 4];

        // Find the opener (first non-pass contract bid) and compute its partner
        let openerSeat = null;
        for (let i = 0; i < (auction.length || 0); i++) {
            const b = auction[i];
            if (b && b.token && b.token !== 'PASS') { openerSeat = b.seat || null; break; }
        }
        if (openerSeat) {
            const openerIdx = order.indexOf(openerSeat) >= 0 ? order.indexOf(openerSeat) : null;
            if (openerIdx !== null) {
                const partnerSeat = order[(openerIdx + 2) % 4];
                isPartnerToOpener = (currentSeat === partnerSeat);
            }
        }
    } catch (e) {
        // Fallback: simple positional math (legacy behavior)
        const currentPosition = (auction.length % 4) + 1;
        isPartnerToOpener = currentPosition === 3;
        currentSeat = null;
    }

    auctionLog('First bid is 2C?', firstBidIs2C);
    auctionLog('Is partner responding?', isPartnerToOpener, 'currentSeat=', currentSeat);

    // Check if Strong 2C sequence is still forcing (not yet reached game level)
    const isGameLevel = (bid) => {
        if (!bid || !bid.token) return false;
        const token = bid.token;
        // Game level bids: 3NT, 4C, 4D, 4H, 4S, 5C, 5D, 6+ level, 7+ level
        return /^[4-7]/.test(token) || token === '3NT';
    };

    const hasReachedGame = auction.some(bid => isGameLevel(bid));

    // Respect Active Conventions toggle for Strong 2C
    const strongTwoClubsEnabled = strong2cOn;
    auctionLog('Strong 2C enabled (effective):', strongTwoClubsEnabled);
    auctionLog('Has reached game level?', hasReachedGame);

    if (firstBidIs2C && isPartnerToOpener && strongTwoClubsEnabled && !hasReachedGame) {
        auctionLog('Strong 2C sequence - FORCING response required (must continue to game)');

        // Must respond - cannot pass until game is reached
        auctionLog('Hand HCP:', hand.hcp);
        auctionLog('Hand distribution:', hand.lengths);
        auctionLog('Current auction:', auction.map(b => b.token));

        // Find the last non-pass bid to determine auction state
        let lastBid = null;
        for (let i = auction.length - 1; i >= 0; i--) {
            if (auction[i].token && auction[i].token !== 'PASS') {
                lastBid = auction[i];
                break;
            }
        }

        auctionLog('Last non-pass bid:', lastBid?.token);

        // Determine forced response based on auction sequence and hand strength
        let forcedBid;

        if (!lastBid || lastBid.token === '2C') {
            // First response to 2C opening
            if (hand.hcp >= 8) {
                // Positive response (8+ HCP)
                // Look for 5+ card major suits first
                if (hand.lengths.S >= 5) {
                    forcedBid = new window.Bid('2S');
                    forcedBid.conventionUsed = 'Positive response to Strong 2C (5+ spades, 8+ HCP)';
                } else if (hand.lengths.H >= 5) {
                    forcedBid = new window.Bid('2H');
                    forcedBid.conventionUsed = 'Positive response to Strong 2C (5+ hearts, 8+ HCP)';
                } else if (hand.lengths.D >= 5) {
                    forcedBid = new window.Bid('3D');
                    forcedBid.conventionUsed = 'Positive response to Strong 2C (5+ diamonds, 8+ HCP)';
                } else if (hand.lengths.C >= 5) {
                    forcedBid = new window.Bid('3C');
                    forcedBid.conventionUsed = 'Positive response to Strong 2C (5+ clubs, 8+ HCP)';
                } else {
                    // Balanced hand with 8+ HCP
                    forcedBid = new window.Bid('2NT');
                    forcedBid.conventionUsed = 'Positive balanced response to Strong 2C (8+ HCP, no 5-card suit)';
                }
            } else {
                // Negative/waiting response (0-7 HCP)
                forcedBid = new window.Bid('2D');
                forcedBid.conventionUsed = 'Negative waiting response to Strong 2C (0-7 HCP)';
            }
        } else if (lastBid.token === '2NT') {
            // Check if this is after Strong 2C sequence
            // Look for pattern: 2C ... 2D ... 2NT (with any passes in between)
            let found2C = false;
            let found2D = false;

            for (let bid of auction) {
                if (bid.token === '2C') found2C = true;
                else if (bid.token === '2D' && found2C) found2D = true;
            }

            if (found2C && found2D) {
                // After 2C-2D-2NT sequence, partner cannot pass!
                // This shows balanced 22-24 HCP and is forcing to game
                auctionLog('Detected 2C-2D-2NT sequence - forcing to game!');
                if (hand.hcp >= 10) {
                    // With 10+ HCP, try for slam (South has 22-24, North 10+ = 32+ combined)
                    forcedBid = new window.Bid('4NT');
                    forcedBid.conventionUsed = 'Quantitative 4NT after Strong 2C-2D-2NT (slam try with 10+ HCP)';
                } else {
                    // Weak hand (0-9 HCP), just bid game
                    forcedBid = new window.Bid('3NT');
                    forcedBid.conventionUsed = 'Forced to game after Strong 2C-2D-2NT sequence (0-9 HCP)';
                }
            }
        } else if (lastBid.token && lastBid.token !== '2C' && lastBid.token !== '2D') {
            // North has already made a positive response, and South has rebid
            // North must continue to support or explore further - cannot pass
            auctionLog('After positive response and opener rebid - must continue bidding');

            // Determine appropriate continuation based on South's rebid and North's hand
            if (lastBid.token === '3H' && hand.lengths.H >= 3) {
                // Support hearts with 3+ card support
                forcedBid = new window.Bid('4H');
                forcedBid.conventionUsed = 'Heart support after Strong 2C sequence (forcing to game)';
            } else if (lastBid.token === '3S' && hand.lengths.S >= 3) {
                // Support spades with 3+ card support  
                forcedBid = new window.Bid('4S');
                forcedBid.conventionUsed = 'Spade support after Strong 2C sequence (forcing to game)';
            } else if (hand.hcp >= 12) {
                // Strong hand - explore slam
                forcedBid = new window.Bid('4NT');
                forcedBid.conventionUsed = 'Slam try after Strong 2C sequence (12+ HCP)';
            } else {
                // Weaker hand - bid 3NT (game)
                forcedBid = new window.Bid('3NT');
                forcedBid.conventionUsed = 'Forced to game after Strong 2C sequence';
            }
        } else {
            // Find next available bid at appropriate level
            const nextBids = ['2H', '2S', '2NT', '3C', '3D', '3H', '3S', '3NT', '4C', '4D', '4H', '4S', '4NT'];
            for (const bidString of nextBids) {
                try {
                    const testBid = new window.Bid(bidString);
                    if (isHigherBid(testBid, lastBid)) {
                        forcedBid = testBid;
                        forcedBid.conventionUsed = `Forced response to Strong 2C sequence (${bidString})`;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        auctionLog('Returning forced bid:', forcedBid?.token);
        return forcedBid;
    }

    return null; // No forced response needed
}

async function makeSystemBid() {
    try {
        // Never allow the engine to bid for South (human seat)
        if (currentTurn === 'S') {
            auctionLog('Skipped system bid because currentTurn is South');
            return;
        }

        // Get system's bid for current position
        const hand = currentHands[currentTurn];
        const seatNumber = getSeatNumber(currentTurn);
        // Ensure dealer is always defined when syncing to engine
        const dealerSeat = dealer || (document.getElementById('dealer')?.value || 'S');

        // Initialize system auction if not already done or if we need fresh state
        if (!system.currentAuction || system.currentAuction.bids.length !== currentAuction.length) {
            // initialization logging suppressed in non-debug runs
            // Human is South; keep ourSeat fixed as 'S' for partnership-relative logic
            if (typeof system.startAuctionWithDealer !== 'function') {
                system.startAuctionWithDealer = function (ourSeat, dealerSeat, vulNS, vulEW) {
                    this.startAuction(ourSeat, /*we*/ vulNS, /*they*/ vulEW);
                    if (this.currentAuction && typeof this.currentAuction.reseat === 'function') {
                        this.currentAuction.reseat(dealerSeat);
                    } else if (this.currentAuction) {
                        this.currentAuction.dealer = dealerSeat;
                    }
                };
            }
            system.startAuctionWithDealer('S', dealerSeat, vulnerability.ns, vulnerability.ew);

            // Ensure dealer is set, then add bids via Auction.add to auto-assign seats
            if (typeof system.currentAuction.reseat === 'function') {
                system.currentAuction.reseat(dealerSeat);
            } else {
                system.currentAuction.dealer = dealerSeat;
            }
            currentAuction.forEach(bid => {
                try {
                    system.currentAuction.add(bid);
                } catch (_) {
                    // Fallback in extreme cases: push then reseat so seats get assigned
                    system.currentAuction.bids.push(bid);
                    try { system.currentAuction.reseat(dealerSeat); } catch { /* noop */ }
                }
                // suppressed per housekeeping: do not spam console in tests/UI
            });
        }

        // Check for forced responses (e.g., Strong 2C)
        // suppressed noisy diagnostics in UI/tests
        const forcedBid = checkForcedResponse(hand, currentAuction);

        // Ensure the engine evaluates from the current actor's perspective
        try {
            if (system.currentAuction) {
                system.currentAuction.ourSeat = currentTurn;
                // Keep engine's side-tracking helpers (which rely on system.ourSeat) aligned with the actor
                system.ourSeat = currentTurn;
                // Ensure dealer is retained for seat inference; reseat if missing
                if (!system.currentAuction.dealer && dealer) {
                    system.currentAuction.dealer = dealer;
                }
                if (typeof system.currentAuction.reseat === 'function' && system.currentAuction.dealer) {
                    try { system.currentAuction.reseat(system.currentAuction.dealer); } catch (_) { /* best-effort */ }
                }
            }
        } catch (e) { /* ignore */ }

        // Get bid recommendation
        let recommendedBid = forcedBid || system.getBid(hand);
        const hasTestOverride = (typeof window !== 'undefined' && window.__testConfig && window.__testConfig.recommendation);

        // Tag the bid with the acting seat so explanation logic can distinguish partner vs opponent.
        if (recommendedBid && !recommendedBid.seat) {
            recommendedBid.seat = currentTurn;
        }

        const explanationContext = (system && system.currentAuction) ? system.currentAuction : { bids: currentAuction, dealer: dealerSeat };
        let explanation = recommendedBid.conventionUsed || getConventionExplanation(recommendedBid, explanationContext, currentTurn) || '';

        // When tests inject a recommendation, skip most mutation guards to honor the override,
        // but still run the final cue-force safety below.
        const skipGuardMutations = !!hasTestOverride;

        if (!skipGuardMutations) {
            // Responder safeguard: with game-going strength (>=12 HCP) after having already bid,
            // do not allow a passive PASS before reaching game. Promote to a game contract based on context.
            try {
                if (!forcedBid && recommendedBid && recommendedBid.token === 'PASS') {
                    const partnerSeat = partnerOf(currentTurn);
                    const ourLast = auctionHistory.slice().reverse().find(e => e.position === currentTurn && e?.bid?.token && e.bid.token !== 'PASS');
                    const partnerLastContract = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && /^[1-7]/.test(e?.bid?.token || ''));
                    const auctionReachedGame = (currentAuction || []).some(b => {
                        const t = b?.token || 'PASS';
                        return t === '3NT' || /^[4-7]/.test(t);
                    });

                    // If opponents have acted between our last bid and partner's last contract, treat the auction as competitive
                    // and avoid auto-promoting partner's competitive raise to a game force.
                    let contestedSinceOurLast = false;
                    try {
                        const findLastIndex = (arr, pred) => { for (let i = arr.length - 1; i >= 0; i--) { if (pred(arr[i], i)) return i; } return -1; };
                        const ourIdx = findLastIndex(currentAuction, (b) => b && b.seat === currentTurn && /^[1-7]/.test(b.token || ''));
                        const partnerIdx = findLastIndex(currentAuction, (b) => b && b.seat === partnerSeat && /^[1-7]/.test(b.token || ''));
                        if (ourIdx >= 0 && partnerIdx > ourIdx) {
                            for (let i = ourIdx + 1; i < partnerIdx; i++) {
                                const b = currentAuction[i];
                                if (b && b.seat && b.seat !== currentTurn && b.seat !== partnerSeat && /^[1-7]/.test(b.token || '')) {
                                    contestedSinceOurLast = true;
                                    break;
                                }
                            }
                        }
                    } catch (_) { contestedSinceOurLast = false; }

                    const ourLastToken = ourLast?.bid?.token || '';
                    const partnerToken = partnerLastContract?.bid?.token || '';
                    const partnerLevel = parseInt(partnerToken[0], 10) || 0;
                    const partnerSuit = partnerToken.replace(/^[1-7]/, '') || null;
                    const ourLastSuit = (/^[1-7]/.test(ourLastToken || '')) ? ourLastToken.replace(/^[1-7]/, '') : null;
                    const partnerSimpleRaise = (!!ourLastSuit && partnerSuit === ourLastSuit && partnerLevel === 2);
                    const partnerInviteOrBetter = partnerLevel >= 3 || partnerToken === '2NT' || partnerToken === '3NT';
                    const strongHandForcing = (hand.hcp || 0) >= 15 && !partnerSimpleRaise;
                    const hasMinGameValues = (hand.hcp || 0) >= 12; // avoid forcing to game with sub-invitational values
                    const shouldForceGame = ourLast && partnerLastContract && !auctionReachedGame && !partnerSimpleRaise && !contestedSinceOurLast && ((partnerInviteOrBetter && hasMinGameValues) || strongHandForcing);

                    if (shouldForceGame) {
                        const suit = partnerSuit;
                        const hasSupport = hand.lengths && suit && hand.lengths[suit] >= 3;
                        if (suit === 'H' || suit === 'S') {
                            if (hasSupport) {
                                recommendedBid = new window.Bid(`4${suit}`);
                                explanation = 'Game raise with game-forcing values';
                            } else {
                                recommendedBid = new window.Bid('3NT');
                                explanation = 'Game try with game-forcing values';
                            }
                        } else {
                            // For minor/NT contexts, steer to 3NT as a practical game choice
                            recommendedBid = new window.Bid('3NT');
                            explanation = 'Game try with game-forcing values';
                        }
                    }
                }
            } catch (_) { /* best-effort safeguard */ }

            // --- Integration of the new Bidding Model ---
            // Only call the model when the rules truly have no answer (null/undefined), or when a rules PASS looks suspect (strong hand in a live auction).
            const isOpeningContext = (function () {
                try {
                    if (system && typeof system._isOpeningBid === 'function') return !!system._isOpeningBid();
                    return !currentAuction.some(b => b && b.token && b.token !== 'PASS');
                } catch (_) { return false; }
            })();

            const rulesReturnedNull = !recommendedBid || recommendedBid.token == null;
            // Only treat a PASS as suspicious when we have NOT previously bid (first action).
            // Allow model consult when partner has acted (so advancer/responder can override a silent PASS),
            // but avoid having the model invent speculative direct overcalls when our side has not yet entered the auction.
            let ourSideHasBid = false;
            let ourSideHasContract = false;
            let weHaveActed = false;
            try {
                const ctx = (system && typeof system._seatContext === 'function') ? system._seatContext() : null;
                if (ctx?.lastOur && ctx.lastOur.token) ourSideHasBid = true;
                if (ctx?.weHaveBid) weHaveActed = true;
                if (ctx?.ourSide && Array.isArray(currentAuction)) {
                    ourSideHasContract = currentAuction.some(b => {
                        const tok = b?.token || '';
                        return /^[1-7]/.test(tok) && ctx.ourSide.includes(b.seat);
                    });
                }
            } catch (_) { ourSideHasBid = false; ourSideHasContract = false; weHaveActed = false; }
            try {
                // Fallback detection for whether we personally have already bid a contract
                const lastSelf = auctionHistory.find(e => e.position === currentTurn && e?.bid && e.bid.token && e.bid.token !== 'PASS');
                if (lastSelf) weHaveActed = true;
            } catch (_) { /* ignore */ }
            const rulesPassButStrong = (!rulesReturnedNull && !forcedBid && recommendedBid.token === 'PASS' && (hand.hcp || 0) >= 10 && currentAuction.length > 0 && !isOpeningContext && !weHaveActed && ourSideHasBid);
            const allowModelFallback = !isOpeningContext;

            if ((rulesReturnedNull || rulesPassButStrong) && !forcedBid && allowModelFallback) {
                const why = rulesReturnedNull ? 'null from rules' : 'rules PASS with 10+ HCP';
                auctionLog(`Rules fallback trigger for ${currentTurn}: ${why}. Consulting bidding model...`);
                try {
                    const context = {
                        dealer: dealer,
                        vulnerability: vulnerability,
                        currentTurn: currentTurn
                    };
                    const modelBidResult = await getModelBid(currentAuction.map(b => b.token || 'PASS'), hand, context);
                    const modelBidToken = (modelBidResult && typeof modelBidResult === 'object') ? modelBidResult.token : modelBidResult;
                    const modelConfidence = (modelBidResult && typeof modelBidResult === 'object') ? modelBidResult.confidence : null;

                    if (modelConfidence !== null && modelConfidence !== undefined) {
                        auctionLog(`Model fallback confidence for ${currentTurn}: ${(modelConfidence * 100).toFixed(1)}% (${modelBidToken || 'PASS'})`);
                    }

                    const passesThreshold = modelBidToken && modelBidToken !== 'PASS' && (modelConfidence === null || modelConfidence >= MODEL_CONFIDENCE_THRESHOLD);
                    if (passesThreshold) {
                        recommendedBid = new window.Bid(modelBidToken);
                        auctionLog(`Model fallback applied for ${currentTurn}: ${modelBidToken}`);
                    } else if (modelConfidence !== null && modelConfidence < MODEL_CONFIDENCE_THRESHOLD) {
                        auctionLog(`Model bid discarded due to low confidence (<${(MODEL_CONFIDENCE_THRESHOLD * 100).toFixed(0)}%). Keeping rules recommendation ${recommendedBid?.token || 'PASS'}.`);
                    }
                } catch (e) {
                    console.error("Bidding model fallback failed:", e);
                }
            }

            // Avoid unsafe NT contracts suggested by the model when we lack a stopper in opponents' last bid suit.
            try {
                if (!forcedBid && !hasTestOverride && recommendedBid && recommendedBid.token && recommendedBid.token.endsWith('NT')) {
                    const lastOppSuitBid = (() => {
                        const isOpp = (pos) => {
                            if (!pos) return false;
                            const ns = currentTurn === 'N' || currentTurn === 'S';
                            return ns ? (pos === 'E' || pos === 'W') : (pos === 'N' || pos === 'S');
                        };
                        const last = auctionHistory.slice().reverse().find(e => {
                            const tok = e?.bid?.token || '';
                            return /^[1-7][CDHS]$/.test(tok) && isOpp(e.position);
                        });
                        return last ? last.bid.token.replace(/^[1-7]/, '') : null;
                    })();

                    const hasStopper = (suit) => {
                        if (!suit) return true;
                        const len = (hand.lengths && hand.lengths[suit]) || 0;
                        const cards = (hand.suitBuckets?.[suit] || []).map(c => c.rank);
                        if (cards.includes('A')) return true; // any ace is a stopper
                        if (cards.includes('K') && len >= 2) return true; // guarded king
                        const hasQueen = cards.includes('Q');
                        const supportHonor = cards.includes('J') || cards.includes('T');
                        if (hasQueen && supportHonor && len >= 3) return true; // QJx/QTx+ length counts as partial control
                        return false; // e.g., bare/queen doubleton is not a stopper
                    };

                    if (lastOppSuitBid && !hasStopper(lastOppSuitBid)) {
                        // Try to steer to our longest suit (non-opponent suit) if legal, else pass.
                        const order = ['S', 'H', 'D', 'C'];
                        const best = order
                            .filter(s => s !== lastOppSuitBid)
                            .map(s => ({ s, len: (hand.lengths && hand.lengths[s]) || 0 }))
                            .filter(o => o.len >= 5)
                            .sort((a, b) => b.len - a.len || order.indexOf(a.s) - order.indexOf(b.s))[0];
                        if (best) {
                            const newTok = `${recommendedBid.token[0]}${best.s}`;
                            recommendedBid = new window.Bid(newTok);
                            explanation = 'Avoiding NT without stopper; choosing natural suit';
                        } else {
                            recommendedBid = new window.Bid('PASS');
                            explanation = 'Pass - no stopper for opponents\' suit';
                        }
                    }
                }
            } catch (_) { /* best-effort NT safety */ }

            // Guard: natural overcalls must have adequate length (prevent 2C/2D overcalls on 3-card suits)
            try {
                ({ recommendedBid, explanation } = applyOvercallLengthGuard({
                    recommendedBid,
                    explanation,
                    forcedBid,
                    currentTurn,
                    auctionHistory,
                    hand,
                    isOpponentPosition
                }));
                if (recommendedBid && !(recommendedBid instanceof window.Bid)) {
                    recommendedBid = new window.Bid(recommendedBid.token || 'PASS');
                }
            } catch (_) { /* soft length guard for overcalls */ }

            // Guard: avoid low-HCP two-level new-suit actions after having previously passed
            if (!hasTestOverride) {
                try {
                    ({ recommendedBid, explanation } = applyTwoLevelFreeBidGuard({
                        recommendedBid,
                        explanation,
                        forcedBid,
                        currentTurn,
                        auctionHistory,
                        hand
                    }));
                    if (recommendedBid && !(recommendedBid instanceof window.Bid)) {
                        recommendedBid = new window.Bid(recommendedBid.token || 'PASS');
                    }
                } catch (_) { /* soft guard for marginal two-level new-suit tries */ }
            }

            // Responder 2-over-1 preference: always show the longest 5+ suit (prefer majors) before a cheaper minor suggestion.
            try {
                if (!forcedBid && !hasTestOverride && recommendedBid && /^[12][CDHS]$/.test(recommendedBid.token)) {
                    const partnerSeat = partnerOf(currentTurn);
                    const weHaveBidContract = auctionHistory.some(e => e.position === currentTurn && /^[1-7]/.test(e?.bid?.token || ''));
                    const partnerLastContract = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
                    const openerTok = partnerLastContract?.bid?.token || '';
                    const openerLevel = parseInt(openerTok[0], 10) || 0;
                    const openerSuit = openerTok.replace(/^[1-7]/, '') || null;
                    const lengths = hand.lengths || {};
                    const rank = { C: 0, D: 1, H: 2, S: 3 };
                    const suitOrder = ['S', 'H', 'D', 'C'];

                    if (!weHaveBidContract && openerLevel === 1 && openerSuit) {
                        const candidates = suitOrder
                            .filter(s => s !== openerSuit && (lengths[s] || 0) >= 5)
                            .map(s => ({ s, len: lengths[s] || 0 }))
                            .sort((a, b) => (b.len - a.len) || (rank[b.s] - rank[a.s])); // prefer longer, then higher-ranked (S > H > D > C)

                        const best = candidates[0];
                        if (best) {
                            const needsTwoLevel = (rank[best.s] <= rank[openerSuit]);
                            const level = needsTwoLevel ? 2 : 1;
                            const newToken = `${level}${best.s}`;
                            if (newToken !== recommendedBid.token) {
                                const suitNames = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };
                                recommendedBid = new window.Bid(newToken);
                                recommendedBid.seat = currentTurn;
                                explanation = `Natural ${newToken} response: 5+ ${suitNames[best.s] || best.s}, show longest suit first`;
                            }
                        }
                    }
                }
            } catch (_) { /* best-effort responder suit preference */ }

            // Guard against model suggesting a short natural overcall; re-route to our longest valid suit.
            try {
                const tok = recommendedBid?.token || '';
                // Only intervene for new-suit natural overcalls when our side is silent so far.
                if (!forcedBid && !hasTestOverride && !ourSideHasBid && /^[1-7][CDHS]$/.test(tok)) {
                    const opponentsHaveContract = (() => {
                        const sameSide = (pos) => {
                            if (!pos) return false;
                            const ns = currentTurn === 'N' || currentTurn === 'S';
                            return ns ? (pos === 'N' || pos === 'S') : (pos === 'E' || pos === 'W');
                        };
                        return auctionHistory.some(e => {
                            const tok = e?.bid?.token || '';
                            return /^[1-7][CDHS]$/.test(tok) && e?.position && !sameSide(e.position);
                        });
                    })();
                    if (!opponentsHaveContract) {
                        throw new Error('skip_overcall_length_guard_no_opp_contract');
                    }
                    const level = parseInt(tok[0], 10) || 0;
                    const suit = tok[1];
                    const lengths = hand.lengths || {};
                    const suitLen = lengths[suit] || 0;
                    const minLen = level >= 2 ? 5 : 4;

                    const suitOrder = ['S', 'H', 'D', 'C'];
                    const findBestSuit = (minRequired) => {
                        return suitOrder
                            .map((s) => ({ s, len: lengths[s] || 0 }))
                            .filter(({ len }) => len >= minRequired)
                            .sort((a, b) => (b.len - a.len) || (suitOrder.indexOf(a.s) - suitOrder.indexOf(b.s)))[0];
                    };

                    if (suitLen < minLen) {
                        const replacement = findBestSuit(minLen) || findBestSuit(4);
                        if (replacement && replacement.s && replacement.s !== suit) {
                            const newToken = `${level}${replacement.s}`;
                            recommendedBid = new window.Bid(newToken);
                            recommendedBid.seat = currentTurn;
                            explanation = `Adjusted to natural ${newToken} (length ${replacement.len}) after filtering model`;
                        } else {
                            // No legal-length suit available – decline the speculative overcall
                            recommendedBid = new window.Bid('PASS');
                            recommendedBid.seat = currentTurn;
                            explanation = 'Pass - insufficient length/strength for overcall';
                        }
                    }
                }
            } catch (_) { /* best-effort natural-suit length guard */ }

            // Direct-seat Michaels cue-bid over opener's suit when holding classic 5-5 shape and strength
            try {
                if (!forcedBid && !hasTestOverride && (!recommendedBid || recommendedBid.token === 'PASS') && !ourSideHasBid) {
                    const openingEntry = (auctionHistory || []).find(e => e && e.bid && /^[1-7](C|D|H|S|NT)$/.test(e.bid.token));
                    if (openingEntry && openingEntry.bid.token !== '1NT') {
                        const openingSuit = openingEntry.bid.token.replace(/^[1-7]/, '');
                        const oppSide = (currentTurn === 'N' || currentTurn === 'S') ? ['E', 'W'] : ['N', 'S'];
                        const onOpponentsSide = oppSide.includes(openingEntry.position);
                        // Direct seat: no non-pass actions after opener and before us
                        let directSeat = false;
                        if (onOpponentsSide) {
                            let sawOpening = false;
                            directSeat = true;
                            for (const e of auctionHistory) {
                                const tok = e?.bid?.token || 'PASS';
                                if (!sawOpening) {
                                    if (e === openingEntry) sawOpening = true;
                                    continue;
                                }
                                if (tok !== 'PASS') { directSeat = false; break; }
                                if (e.position === currentTurn) break; // safety
                            }
                        }

                        const len = hand.lengths || {};
                        const hcp = hand.hcp || 0;
                        const hasMajors55 = len.H >= 5 && len.S >= 5;
                        const hasSpadesPlusMinor55 = len.S >= 5 && (len.C >= 5 || len.D >= 5);
                        const hasHeartsPlusMinor55 = len.H >= 5 && (len.C >= 5 || len.D >= 5);

                        const michaelsShape = (
                            (openingSuit === 'C' || openingSuit === 'D') ? hasMajors55 :
                                (openingSuit === 'H') ? hasSpadesPlusMinor55 :
                                    (openingSuit === 'S') ? hasHeartsPlusMinor55 : false
                        );

                        if (onOpponentsSide && directSeat && michaelsShape && hcp >= 10) {
                            const cueTok = `2${openingSuit}`;
                            recommendedBid = new window.Bid(cueTok);
                            recommendedBid.seat = currentTurn;
                            explanation = detectMichaelsCueBid(currentTurn, recommendedBid, auctionHistory, hand) || 'Michaels cue-bid (two-suited overcall)';
                        }
                    }
                }
            } catch (_) { /* soft Michaels generator */ }

            // Prefer NT overcall with balanced strength and stopper instead of a low-level suit when appropriate.
            try {
                const tok = recommendedBid?.token || '';
                if (!forcedBid && !hasTestOverride && /^[12][CDHS]$/.test(tok) && !ourSideHasContract) {
                    const lastOppContract = auctionHistory.slice().reverse().find(e => {
                        const t = e?.bid?.token || '';
                        const isContract = /^[1-7][CDHS]$/.test(t);
                        if (!isContract) return false;
                        const oppSide = (currentTurn === 'N' || currentTurn === 'S') ? ['E', 'W'] : ['N', 'S'];
                        return oppSide.includes(e.position);
                    });
                    if (lastOppContract) {
                        const oppTok = lastOppContract.bid.token || '';
                        const oppSuit = oppTok.replace(/^[1-7]/, '') || null;
                        const oppLevel = parseInt(oppTok[0], 10) || 0;
                        const hcp = hand.hcp || 0;
                        const lengths = hand.lengths || {};
                        const lens = ['S', 'H', 'D', 'C'].map(s => lengths[s] || 0);
                        const is4333 = lens.filter(v => v === 4).length === 1 && lens.filter(v => v === 3).length === 3;
                        const is4432 = lens.filter(v => v === 4).length === 2 && lens.filter(v => v === 3).length === 1 && lens.filter(v => v === 2).length === 1;
                        const is5332 = lens.filter(v => v === 5).length === 1 && lens.filter(v => v === 3).length === 2 && lens.filter(v => v === 2).length === 1;
                        const balanced = is4333 || is4432 || is5332;
                        const hasStopper = (suit) => {
                            if (!suit) return true;
                            const cards = (hand.suitBuckets?.[suit] || []).map(c => c.rank);
                            const len = lengths[suit] || 0;
                            if (cards.includes('A')) return true;
                            if (cards.includes('K') && len >= 2) return true;
                            const hasQueen = cards.includes('Q');
                            const supportHonor = cards.includes('J') || cards.includes('T');
                            if (hasQueen && supportHonor && len >= 3) return true;
                            return false;
                        };

                        if (balanced && hasStopper(oppSuit)) {
                            if (hcp >= 15 && hcp <= 18 && oppLevel === 1) {
                                recommendedBid = new window.Bid('1NT');
                                recommendedBid.seat = currentTurn;
                                explanation = '1NT overcall: 15-18 balanced with stopper';
                            } else if (hcp >= 19 && hcp <= 20 && oppLevel <= 2) {
                                recommendedBid = new window.Bid('2NT');
                                recommendedBid.seat = currentTurn;
                                explanation = '2NT overcall: 19-20 balanced with stopper';
                            }
                        }
                    }
                }
            } catch (_) { /* best-effort NT overcall preference */ }

            // Opener rebid in own suit after interference requires 6+ cards or extra values.
            try {
                const tok = recommendedBid?.token || '';
                if (!forcedBid && /^[1-7][CDHS]$/.test(tok)) {
                    const suit = tok.replace(/^[1-7]/, '');
                    const level = parseInt(tok[0], 10) || 0;
                    const firstOurContract = auctionHistory.find(e => e.position === currentTurn && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
                    const lastOppContract = auctionHistory.slice().reverse().find(e => {
                        const t = e?.bid?.token || '';
                        if (!/^[1-7][CDHS]$/.test(t)) return false;
                        return e.position && e.position !== currentTurn && e.position !== partnerOf(currentTurn);
                    });

                    if (firstOurContract && lastOppContract) {
                        const firstSuit = firstOurContract.bid.token.replace(/^[1-7]/, '');
                        const firstLevel = parseInt(firstOurContract.bid.token[0], 10) || 1;
                        const len = (hand.lengths && hand.lengths[suit]) || 0;
                        const hcp = hand.hcp || 0;
                        const rebiddingSameSuit = suit === firstSuit && level >= firstLevel;
                        if (rebiddingSameSuit && (len < 6 || hcp < 14)) {
                            recommendedBid = new window.Bid('PASS');
                            recommendedBid.seat = currentTurn;
                            explanation = 'Pass - suit rebid needs 6+ cards or extra strength after interference';
                        }
                    }
                }
            } catch (_) { /* best-effort opener rebid sanity */ }

            // Guard against speculative NT inventions from the model when our side has not entered the auction with a contract.
            try {
                const tok = recommendedBid?.token || '';
                if (!forcedBid && tok.endsWith('NT') && !ourSideHasContract) {
                    const minHcpForNTEntry = 15; // avoid NT overcalls/inventions with sub-invitational strength
                    if ((hand.hcp || 0) < minHcpForNTEntry) {
                        recommendedBid = new window.Bid('PASS');
                        explanation = 'Pass';
                    }
                }
            } catch (_) { /* best-effort NT sanity guard */ }

            // Competitive self-raise sanity: avoid jump-raising our own suit in competition without length and invitational values
            try {
                const tok = recommendedBid?.token || '';
                if (!forcedBid && /^[3-7][CDHS]$/.test(tok)) {
                    const suit = tok.replace(/^[1-7]/, '');
                    const ourLastContract = auctionHistory.slice().reverse().find(e => e.position === currentTurn && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
                    const ourSuit = ourLastContract?.bid?.token ? ourLastContract.bid.token.replace(/^[1-7]/, '') : null;
                    const isSelfRaise = ourSuit && suit === ourSuit && (parseInt(tok[0], 10) || 0) >= 3;
                    const oppHasBid = auctionHistory.some(e => {
                        const t = e?.bid?.token || '';
                        return /^[1-7][CDHS]$/.test(t) && e.position && e.position !== currentTurn && e.position !== partnerOf(currentTurn);
                    });

                    if (isSelfRaise && oppHasBid) {
                        const len = (hand.lengths && hand.lengths[suit]) || 0;
                        const minLen = 5; // require at least a 5-card suit for competitive self-raise
                        const minHcp = 12; // need invitational values to compete at the three-level
                        if (len < minLen || (hand.hcp || 0) < minHcp) {
                            recommendedBid = new window.Bid('PASS');
                            recommendedBid.seat = currentTurn;
                            explanation = 'Pass - insufficient length/values for competitive jump raise';
                        }
                    }
                }
            } catch (_) { /* best-effort competitive raise sanity */ }
        } // end skipGuardMutations

        // Ensure the bid retains the acting seat after any model-driven replacement.
        if (recommendedBid && !recommendedBid.seat) {
            recommendedBid.seat = currentTurn;
        }

        // If rules/model produced no bid at all, normalize to a Pass bid to keep downstream logic safe
        if (!recommendedBid) {
            recommendedBid = new window.Bid('PASS');
            explanation = 'Pass';
        }

        // Normalize shorthand NT tokens that may come back from the model (e.g., 4N -> 4NT)
        try {
            const tok = recommendedBid?.token || '';
            if (/^[1-7]N$/.test(tok)) {
                const normalized = `${tok}T`;
                recommendedBid = new window.Bid(normalized);
                if (!explanation) explanation = '';
            }
        } catch (_) { /* best-effort normalization */ }

        // Do not let the auction die in opponents' suit after partner makes a cue-bid (one-round force)
        try {
            if (!forcedBid && recommendedBid && recommendedBid.token === 'PASS') {
                const partnerSeat = partnerOf(currentTurn);
                const lastPartnerAction = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && e.bid && e.bid.token && e.bid.token !== 'PASS');
                const partnerCue = (() => {
                    if (!lastPartnerAction) return false;
                    const tok = lastPartnerAction?.bid?.token || '';
                    const suit = tok.replace(/^[1-7]/, '');
                    if (!tok || tok === 'PASS' || tok === 'X' || tok === 'XX' || suit === 'NT') return false;
                    const oppSeats = (partnerSeat === 'N' || partnerSeat === 'S') ? ['E', 'W'] : ['N', 'S'];
                    return auctionHistory.some(entry => {
                        const t = entry?.bid?.token || 'PASS';
                        if (!/^[1-7]/.test(t)) return false;
                        const entrySuit = t.replace(/^[1-7]/, '');
                        return oppSeats.includes(entry?.position) && entrySuit === suit;
                    });
                })();

                if (partnerCue) {
                    // Find our side's last strain (non-cue contract) to steer to game in that strain; else default to 4NT
                    const sameSide = (seat) => (seat === 'N' || seat === 'S') ? 'NS' : 'EW';
                    const sideTag = sameSide(currentTurn);
                    const lastOurContract = auctionHistory.slice().reverse().find(e => {
                        const tok = e?.bid?.token || 'PASS';
                        if (!/^[1-7]/.test(tok)) return false;
                        if (isCueBidOfOpponentsSuit(e.position, e.bid, auctionHistory)) return false;
                        return sameSide(e.position) === sideTag;
                    });

                    const strain = lastOurContract ? lastOurContract.bid.token.replace(/^[1-7]/, '') : null;
                    const gameLevelFor = (s) => {
                        if (s === 'C' || s === 'D') return 5;
                        if (s === 'H' || s === 'S') return 4;
                        if (s === 'NT') return 4;
                        return 4;
                    };

                    let fallbackToken = '4NT';
                    if (strain) {
                        const level = gameLevelFor(strain);
                        fallbackToken = `${level}${strain === 'NT' ? 'NT' : strain}`;
                    }

                    recommendedBid = new window.Bid(fallbackToken);
                    explanation = 'Forcing over partner cue-bid';
                }
            }
        } catch (_) { /* best-effort cue-force safeguard */ }

        // If system recommended a takeout double, show a small inline hint with shape rationale
        try {
            if (recommendedBid && recommendedBid.isDouble) {
                const label = explanation || 'Takeout Double';
                // If engine didn't include shape details, add a concise note based on visible auction context
                let annotated = label;
                if (!/short|4-3|support|takeout/i.test(label)) {
                    // Infer opener suit for guidance
                    let oppSuit = null;
                    for (let i = 0; i < currentAuction.length; i++) {
                        const t = currentAuction[i]?.token;
                        if (t && /^[1-7][CDHS]$/.test(t)) { oppSuit = t.slice(1); break; }
                    }
                    if (oppSuit) {
                        const name = (s) => ({ C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' }[s] || s);
                        annotated = `${label} (takeout over ${name(oppSuit)}: short/acceptably short there; support across other suits)`;
                    }
                }
                showInlineHintChip('X', annotated);
            }
        } catch (_) { /* non-fatal UI hint */ }

        // Normalize obviously inconsistent explanations
        try {
            const tok = recommendedBid.token || 'PASS';
            // Always normalize PASS explanation
            if (tok === 'PASS') {
                explanation = 'Pass';
            }
            // If explanation claims a Strong 2C response but partner did not open 2C, replace with contextual mapping
            if (typeof explanation === 'string' && /Strong 2C/i.test(explanation)) {
                const firstNonPass = (currentAuction || []).find(b => (b.token || 'PASS') !== 'PASS');
                // Determine partner seat relative to current turn
                const partnerSeat = (currentTurn === 'S') ? 'N' : (currentTurn === 'N') ? 'S' : (currentTurn === 'E') ? 'W' : 'E';
                let firstByPartnerIs2C = false;
                if (auctionHistory && auctionHistory.length > 0) {
                    for (const e of auctionHistory) {
                        const t = e?.bid?.token || 'PASS';
                        if (t !== 'PASS') {
                            firstByPartnerIs2C = (e.position === partnerSeat && t === '2C');
                            break;
                        }
                    }
                }
                if (!firstByPartnerIs2C) {
                    // Not a partner 2C opening sequence; recompute a neutral explanation
                    explanation = getConventionExplanation(recommendedBid, currentAuction, currentTurn) || '';
                }
            }
        } catch (_) { /* best-effort */ }

        // Engine-side legality guard for UI preview: if engine marks it illegal, show PASS instead (unless forced)
        try {
            if (!forcedBid && typeof system.isLegal === 'function') {
                const legal = system.isLegal(recommendedBid);
                if (!legal) {
                    console.warn(`${currentTurn} recommended illegal bid by engine guard, passing instead`);
                    recommendedBid = new window.Bid('PASS');
                    explanation = 'Pass';
                }
            }
        } catch (_) { /* non-fatal */ }

        // Safety filter: prevent weak/indirect or invalid-shape cue-bids of opener's suit (e.g., Michaels)
        // Context: Occasionally, in multi-bid auctions like 1m - Pass - 1H - (?), a 2m cue-bid can slip through
        // from engine fallbacks even with very weak hands. In mainstream styles, a cue-bid of opener's suit here
        // should be either a conventional two-suited overcall (Michaels) made in direct seat, or a strong raise
        // by opener's side after interference (which we never are when partner passed). Guard it at UI level to
        // avoid surprising bids during practice when HCP is clearly insufficient.
        if (!forcedBid && recommendedBid && recommendedBid.token && /^[2-7][CDHS]$/.test(recommendedBid.token)) {
            if (!hasTestOverride) try {
                // Identify original opening suit (first contract in the auction history)
                const openingEntry = (auctionHistory || []).find(e => e && e.bid && e.bid.token && /^[1-7](C|D|H|S|NT)$/.test(e.bid.token));
                const openingToken = openingEntry?.bid?.token;
                const openingSuit = openingToken && openingToken.length >= 2 && openingToken !== '1NT' ? openingToken[1] : null;
                const openingSeat = openingEntry?.position || null; // 'N','E','S','W'
                // If we can't determine the opener's seat (e.g., in minimal test stubs), do not apply this guard.
                if (!openingSeat) {
                    // Skip safety filter when opener side can't be determined; avoid blocking simple responder raises
                    throw new Error('skip_cue_guard');
                }

                // Determine side parity: are we on opener's side or the opponents' side?
                const isNS = (s) => s === 'N' || s === 'S';
                const isEW = (s) => s === 'E' || s === 'W';
                const onOpenersSide = openingSeat ? ((isNS(openingSeat) && isNS(currentTurn)) || (isEW(openingSeat) && isEW(currentTurn))) : false;
                // If we're on opener's side (responder or opener), never treat a 2-level bid of opener's suit as a Michaels cue.
                if (onOpenersSide) {
                    throw new Error('skip_cue_guard_on_side');
                }

                // Determine if there was any intervening non-pass action after the opening (i.e., not direct seat)
                let nonPassAfterOpening = false;
                if (openingToken) {
                    let seenOpening = false;
                    for (const e of (auctionHistory || [])) {
                        const tok = e?.bid?.token || (e?.bid?.isDouble ? 'X' : e?.bid?.isRedouble ? 'XX' : 'PASS');
                        if (!seenOpening) {
                            if (tok === openingToken) seenOpening = true;
                            continue;
                        }
                        if (seenOpening && tok && tok !== 'PASS') { nonPassAfterOpening = true; break; }
                    }
                }

                // Is this a cue-bid of the opener's suit at the 2-level?
                const isCueOfOpeningSuit = (openingSuit && recommendedBid.token === `2${openingSuit}`);

                // Config: honor Michaels settings; if direct_only is true, disallow indirect seat cue-bids as two-suited overcalls.
                const michaelsCfg = system?.conventions?.config?.competitive?.michaels || {};
                const directOnly = (michaelsCfg.direct_only !== undefined) ? !!michaelsCfg.direct_only : true;

                // HCP threshold for any indirect cue-bid: require at least 8 HCP to proceed.
                const tooWeak = (hand.hcp || 0) < 8;

                // Shape check for Michaels validity when cueing opener's suit
                let invalidMichaelsShape = false;
                if (isCueOfOpeningSuit && hand && hand.lengths) {
                    const len = hand.lengths;
                    const majors55 = (len.H >= 5 && len.S >= 5);
                    const spadesPlusMinor55 = (len.S >= 5 && (len.C >= 5 || len.D >= 5));
                    const heartsPlusMinor55 = (len.H >= 5 && (len.C >= 5 || len.D >= 5));
                    if ((openingSuit === 'C' || openingSuit === 'D') && !majors55) invalidMichaelsShape = true;
                    if (openingSuit === 'H' && !spadesPlusMinor55) invalidMichaelsShape = true;
                    if (openingSuit === 'S' && !heartsPlusMinor55) invalidMichaelsShape = true;
                }

                // Only treat 2-level cue of opener's suit as a potential Michaels overcall when we're on the OPPONENTS' side.
                // If we're on opener's side (i.e., responder or opener), a 2-level bid in opener's suit is a simple raise, not a cue-bid — don't block it.
                if (!onOpenersSide && isCueOfOpeningSuit && (nonPassAfterOpening && (directOnly || tooWeak) || invalidMichaelsShape)) {
                    // Downgrade to Pass instead of making a speculative/invalid cue-bid
                    console.warn(`Blocking indirect/weak cue-bid ${recommendedBid.token} with ${hand.hcp} HCP; using PASS instead.`);
                    recommendedBid = new window.Bid('PASS');
                    explanation = 'Pass';
                }
            } catch (guardErr) {
                // If we intentionally skipped due to unknown opener seat, silently ignore
            }
        }
        // Validate the recommended bid - if invalid, pass instead (unless it's a forced bid)
        const bidToken = recommendedBid.token || 'PASS';
        if (forcedBid) {
            // Forced bids always valid (e.g., Strong 2C responses)
            auctionLog(`${currentTurn} making forced bid: ${bidToken}`);
        } else if (bidToken !== 'PASS' && !isValidSystemBid(bidToken, currentTurn)) {
            console.warn(`${currentTurn} recommended invalid bid ${bidToken}, passing instead`);
            recommendedBid = new window.Bid('PASS'); // Create proper PASS bid
            // Keep explanation simple per UX guidance
            explanation = 'Pass';
        } else if (bidToken === 'PASS' || recommendedBid.token === 'PASS') {
            explanation = 'Pass';
        }

        // If partner overcalled naturally and opponents cue-bid that suit, avoid speculative high-level raises with weak/support-less hands
        try {
            const partnerSeat = partnerOf(currentTurn);
            const partnerLast = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
            const partnerSuit = partnerLast ? partnerLast.bid.token.replace(/^[1-7]/, '') : null;
            if (partnerSuit) {
                const partnerIdx = auctionHistory.lastIndexOf(partnerLast);
                const oppCueAfterPartner = auctionHistory.slice(partnerIdx + 1).find(e => {
                    const tok = e?.bid?.token || '';
                    if (!/^[1-7][CDHS]$/.test(tok)) return false;
                    const suit = tok.replace(/^[1-7]/, '');
                    const opp = isOpponentPosition(e.position, currentTurn);
                    return opp && suit === partnerSuit;
                });
                const weakHcp = (hand?.hcp || 0) <= 6;
                const shortTrump = (hand?.lengths?.[partnerSuit] || 0) < 4;
                const isHighRaiseOfPartnerSuit = recommendedBid && /^[4-7][CDHS]$/.test(recommendedBid.token) && recommendedBid.token.replace(/^[1-7]/, '') === partnerSuit;
                if (oppCueAfterPartner && isHighRaiseOfPartnerSuit && (weakHcp || shortTrump)) {
                    recommendedBid = new window.Bid('PASS');
                    explanation = 'Pass';
                }
            }
        } catch (_) { /* conservative guard only */ }

        // Competitive cue-bid explanation: if bidding opponents' previously-bid suit
        if (!forcedBid && recommendedBid.token && recommendedBid.token !== 'PASS' && recommendedBid.token !== 'X' && recommendedBid.token !== 'XX') {
            try {
                const michaelsInfo = detectMichaelsCueBid(currentTurn, recommendedBid, auctionHistory, hand);
                if (michaelsInfo) {
                    explanation = michaelsInfo; // Detailed Michaels description
                } else {
                    const isCue = isCueBidOfOpponentsSuit(currentTurn, recommendedBid, auctionHistory);
                    if (isCue) {
                        explanation = 'Cue bid of opponents\' suit';
                    }
                }
            } catch (_) { }
        }

        // Opportunistic opener-game rule: if we were going to PASS but partner just made
        // a forcing cue-bid raise and we hold strong opener values, continue to an appropriate
        // game-level contract instead of passing. This is a narrow, low-risk heuristic that
        // fixes cases where clear combined strength and shown support should force game.
        try {
            if (!forcedBid && recommendedBid && (recommendedBid.token === 'PASS' || !recommendedBid.token)) {
                // Find last non-pass auction entry in history
                const lastNonPass = auctionHistory.slice().reverse().find(e => e.bid && e.bid.token && e.bid.token !== 'PASS');
                if (lastNonPass) {
                    // Check that the last non-pass was by our partner
                    const partnerSeat = (currentTurn === 'S') ? 'N' : (currentTurn === 'N') ? 'S' : (currentTurn === 'E') ? 'W' : 'E';
                    if (lastNonPass.position === partnerSeat) {
                        // Was it a cue-bid raise? Prefer to use the system's convention explanation when present
                        const cueLabel = (lastNonPass.explanation || '').toLowerCase();
                        const isCueRaise = /cue bid raise|cue bid \(forcing\)|cue bid of opponents' suit/i.test(lastNonPass.explanation || '') || isCueBidOfOpponentsSuit(currentTurn, lastNonPass.bid, auctionHistory);
                        if (isCueRaise && (hand.hcp || 0) >= 17) {
                            // Choose a game: prefer 4M if partner cue-raised a major; else 3NT fallback
                            const partnerBidTok = lastNonPass.bid.token || '';
                            const suit = partnerBidTok.replace(/^[1-7]/, '');
                            let gameTok = '3NT';
                            if (suit === 'H' || suit === 'S') gameTok = `4${suit}`;
                            recommendedBid = new window.Bid(gameTok);
                            explanation = 'Game: combined strength and shown support';
                        }
                    }
                }
            }
        } catch (e) { /* non-fatal heuristic */ }

        // Guard: avoid overreaching NT responses with insufficient HCP (e.g., 2NT with <12 HCP)
        try {
            if (!forcedBid && recommendedBid && recommendedBid.token === '2NT') {
                const hcp = typeof hand?.hcp === 'number' ? hand.hcp : null;
                const lastOppBid = auctionHistory.slice().reverse().find(e => e.position && !sameSide(e.position));
                const oppSuit = lastOppBid && lastOppBid.bid && /^[1-7][CDHS]$/.test(lastOppBid.bid.token || '')
                    ? lastOppBid.bid.token.slice(-1)
                    : null;
                const hasControl = oppSuit ? (hand?.lengths?.[oppSuit] || 0) > 0 : true;
                if (hcp !== null && (hcp < 10 || !hasControl)) {
                    recommendedBid = new window.Bid('PASS');
                    explanation = 'Pass (need 10+ HCP and a control in opponents\' suit for 2NT)';
                }
            }
        } catch (_) { /* soft guard */ }

        // Guard: ensure responder shows a major instead of passing when partner opened a lower-ranking suit
        try {
            ({ recommendedBid, explanation } = applyResponderMajorGuard({
                recommendedBid,
                explanation,
                forcedBid,
                currentTurn,
                auctionHistory,
                hand,
                isValidSystemBid,
                computeTotalPoints
            }));
            if (recommendedBid && !(recommendedBid instanceof window.Bid)) {
                recommendedBid = new window.Bid(recommendedBid.token || 'PASS');
            }
        } catch (_) { /* soft safeguard */ }

        // Guard: avoid raising partner without support or values
        try {
            if (!forcedBid && !hasTestOverride && recommendedBid && recommendedBid.token && /^[1-7][CDHS]$/.test(recommendedBid.token)) {
                const partnerSeat = partnerOf(currentTurn);
                const partnerLastContract = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
                if (partnerLastContract) {
                    const partnerTok = partnerLastContract.bid.token || '';
                    const partnerSuit = partnerTok.replace(/^[1-7]/, '');
                    const partnerLevel = parseInt(partnerTok[0], 10) || 0;
                    const ourSuit = recommendedBid.token.replace(/^[1-7]/, '');
                    const ourLevel = parseInt(recommendedBid.token[0], 10) || 0;
                    const raisingPartnerSuit = (ourSuit === partnerSuit) && (ourLevel > partnerLevel);

                    // Only enforce the guard when we have concrete shape/strength info; avoid blocking when hand data is stubbed/missing.
                    const hasShapeInfo = !!(hand?.lengths && Object.values(hand.lengths || {}).some(v => v > 0));
                    const hasHcpInfo = typeof hand?.hcp === 'number' && !Number.isNaN(hand.hcp);
                    const support = hasShapeInfo ? (hand.lengths[partnerSuit] || 0) : null;
                    const hcp = hasHcpInfo ? hand.hcp : null;
                    const weakSupport = hasShapeInfo ? support < 3 : false;
                    const weakHcp = hasHcpInfo ? hcp < 7 : false;

                    if (raisingPartnerSuit && (weakSupport || weakHcp)) {
                        recommendedBid = new window.Bid('PASS');
                        explanation = 'Pass (insufficient strength/support to raise partner)';
                    }
                }
            }
        } catch (_) { /* best-effort safeguard */ }

        // Final safety: never pass a partner cue-bid of opponents' suit (one-round force)
        try {
            if (!forcedBid && recommendedBid && recommendedBid.token === 'PASS') {
                const partnerSeat = partnerOf(currentTurn);
                const lastPartnerAction = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && e?.bid && e.bid.token && e.bid.token !== 'PASS');
                const partnerCue = (() => {
                    if (!lastPartnerAction) return false;
                    // Prefer explicit cue detection; fall back to suit check so we never miss the force
                    if (isCueBidOfOpponentsSuit(lastPartnerAction.position, lastPartnerAction.bid, auctionHistory)) return true;
                    const tok = lastPartnerAction?.bid?.token || '';
                    const suit = tok.replace(/^[1-7]/, '');
                    if (!tok || tok === 'PASS' || tok === 'X' || tok === 'XX' || suit === 'NT') return false;
                    const oppSeats = (partnerSeat === 'N' || partnerSeat === 'S') ? ['E', 'W'] : ['N', 'S'];
                    return auctionHistory.some(entry => {
                        const t = entry?.bid?.token || 'PASS';
                        if (!/^[1-7]/.test(t)) return false;
                        const entrySuit = t.replace(/^[1-7]/, '');
                        return oppSeats.includes(entry?.position) && entrySuit === suit;
                    });
                })();

                if (partnerCue) {
                    const strain = (() => {
                        const lastOurContract = auctionHistory.slice().reverse().find(e => {
                            const tok = e?.bid?.token || '';
                            return sameSide(e.position, currentTurn) && /^[1-7]/.test(tok) && !isCueBidOfOpponentsSuit(e.position, e.bid, auctionHistory);
                        });
                        if (!lastOurContract) return null;
                        return lastOurContract.bid.token.replace(/^[1-7]/, '');
                    })();
                    const gameLevelFor = (s) => {
                        if (s === 'C' || s === 'D') return 5;
                        if (s === 'H' || s === 'S') return 4;
                        if (s === 'NT') return 4;
                        return 4;
                    };
                    const target = strain ? `${gameLevelFor(strain)}${strain === 'NT' ? 'NT' : strain}` : '4NT';
                    recommendedBid = new window.Bid(target);
                    explanation = 'Forcing over partner cue-bid';
                }
            }
        } catch (_) { /* best-effort cue force */ }

        // Normalize any stale labels that don't match the actual bid token
        explanation = normalizeExplanationForBid(recommendedBid, explanation, currentAuction, currentTurn);

        // Log after finalizing legality and explanation so console reflects what will be recorded
        auctionLog('Final recommended bid:', recommendedBid.token || 'PASS');
        auctionLog(`${currentTurn} making bid:`);
        auctionLog(`  Hand: ${hand.toString()}`);
        auctionLog(`  HCP: ${hand.hcp}`);
        auctionLog(`  Current auction length: ${currentAuction.length}`);
        auctionLog(`  Recommended bid: ${recommendedBid.token || 'PASS'}`);
        auctionLog(`  Explanation: ${explanation}`);

        // Responder upgrade: after opener's 2NT, push to game with adequate points
        try {
            if (!forcedBid && currentTurn === 'N' && shouldRaiseToGameAfterOpener2NT(hand, auctionHistory)) {
                const hasFiveSpades = (hand.lengths && hand.lengths.S >= 5);
                // If we previously bid 1S, prefer 4S; else 3NT
                const ourSideBidSpades = auctionHistory.some(e => e.position === 'N' && e.bid && e.bid.token === '1S');
                const target = (hasFiveSpades && ourSideBidSpades) ? '4S' : '3NT';
                recommendedBid = new window.Bid(target);
                explanation = 'Game after opener\'s 2NT';
            }
        } catch (e) { console.warn('Responder game check failed:', e?.message || e); }

        // Absolute last check: never leave partner's cue-bid hanging with a PASS
        try {
            if (!forcedBid && recommendedBid && recommendedBid.token === 'PASS') {
                const partnerSeat = partnerOf(currentTurn);
                const lastPartnerAction = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && e?.bid && e.bid.token && e.bid.token !== 'PASS');
                const partnerCue = (() => {
                    if (!lastPartnerAction) return false;
                    const tok = lastPartnerAction?.bid?.token || '';
                    const suit = tok.replace(/^[1-7]/, '');
                    if (!tok || tok === 'PASS' || tok === 'X' || tok === 'XX' || suit === 'NT') return false;
                    const oppSeats = (partnerSeat === 'N' || partnerSeat === 'S') ? ['E', 'W'] : ['N', 'S'];
                    return auctionHistory.some(entry => {
                        const t = entry?.bid?.token || 'PASS';
                        if (!/^[1-7]/.test(t)) return false;
                        const entrySuit = t.replace(/^[1-7]/, '');
                        return oppSeats.includes(entry?.position) && entrySuit === suit;
                    });
                })();
                if (partnerCue) {
                    const fallback = (() => {
                        const lastOurContract = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && /^[1-7](C|D|H|S|NT)$/.test(e?.bid?.token || '') && !isCueBidOfOpponentsSuit(e.position, e.bid, auctionHistory));
                        if (!lastOurContract) return '4NT';
                        const strain = lastOurContract.bid.token.replace(/^[1-7]/, '');
                        const level = (strain === 'C' || strain === 'D') ? 5 : 4;
                        return `${level}${strain}`;
                    })();
                    recommendedBid = new window.Bid(fallback);
                    explanation = 'Forcing over partner cue-bid';
                }
            }
        } catch (_) { /* non-fatal */ }

        // Keep the engine auction in sync so legality checks see the latest seat/action
        try {
            if (system?.currentAuction) {
                if (!recommendedBid.seat) recommendedBid.seat = currentTurn;
                if (typeof system.currentAuction.add === 'function') {
                    system.currentAuction.add(recommendedBid);
                } else if (Array.isArray(system.currentAuction.bids)) {
                    system.currentAuction.bids.push(recommendedBid);
                    // Ensure seats are populated after direct push
                    if (typeof system.currentAuction.reseat === 'function' && system.currentAuction.dealer) {
                        try { system.currentAuction.reseat(system.currentAuction.dealer); } catch (_) { /* best-effort */ }
                    }
                }
            }
        } catch (_) { /* best-effort sync */ }

        // Final fail-safe: if partner previously cue-bid opponents' suit, do not allow a PASS
        try {
            if (!forcedBid && recommendedBid && recommendedBid.token === 'PASS') {
                auctionLog('Cue-force guard check', {
                    seat: currentTurn,
                    rec: recommendedBid?.token,
                    hist: auctionHistory.length,
                    live: currentAuction.length
                });
                const partnerSeat = partnerOf(currentTurn);
                const opponentSeats = (partnerSeat === 'N' || partnerSeat === 'S') ? ['E', 'W'] : ['N', 'S'];
                let partnerCueEntry = (() => {
                    for (let i = auctionHistory.length - 1; i >= 0; i--) {
                        const entry = auctionHistory[i];
                        if (!entry || entry.position !== partnerSeat) continue;
                        const tok = entry?.bid?.token || '';
                        if (!/^[1-7][CDHS]$/.test(tok)) continue;
                        const suit = tok.replace(/^[1-7]/, '');
                        const oppMatched = auctionHistory.some((opp, idx) => {
                            if (idx >= i) return false; // only earlier opponent bids
                            const t = opp?.bid?.token || 'PASS';
                            if (!/^[1-7]/.test(t)) return false;
                            const s = t.replace(/^[1-7]/, '');
                            return opponentSeats.includes(opp?.position) && s === suit;
                        });
                        if (oppMatched) return { entry, suit };
                    }
                    return null;
                })();

                auctionLog('Cue-force partnerCueEntry found?', !!partnerCueEntry, 'partnerSeat=', partnerSeat);
                if (recommendedBid.token === 'PASS') {
                    auctionLog('Cue-force history snapshot', auctionHistory.map(e => `${e?.position || '?'}:${e?.bid?.token || ''}`));
                }

                // Fallback to the live auction when history is sparse (e.g., jsdom stubs)
                if (!partnerCueEntry && Array.isArray(currentAuction) && currentAuction.length) {
                    const findLastIndex = (arr, pred) => { for (let i = arr.length - 1; i >= 0; i--) { if (pred(arr[i], i)) return i; } return -1; };
                    const idx = findLastIndex(currentAuction, (b) => b && b.seat === partnerSeat && b.token && b.token !== 'PASS');
                    if (idx >= 0) {
                        const bid = currentAuction[idx];
                        const tok = bid?.token || '';
                        const suit = tok.replace(/^[1-7]/, '');
                        if (suit && suit !== 'NT' && tok !== 'X' && tok !== 'XX') {
                            const oppMatch = currentAuction.slice(0, idx).some((opp) => {
                                const t = opp?.token || 'PASS';
                                if (!/^[1-7]/.test(t)) return false;
                                return opponentSeats.includes(opp?.seat) && t.replace(/^[1-7]/, '') === suit;
                            });
                            if (oppMatch) {
                                partnerCueEntry = { entry: { bid, position: partnerSeat }, suit };
                            }
                        }
                    }
                }

                if (partnerCueEntry) {
                    const strain = (() => {
                        const lastOurContract = auctionHistory.slice().reverse().find(e => {
                            const tok = e?.bid?.token || '';
                            return sameSide(e.position, currentTurn) && /^[1-7]/.test(tok) && !isCueBidOfOpponentsSuit(e.position, e.bid, auctionHistory);
                        });
                        if (lastOurContract) {
                            return lastOurContract.bid.token.replace(/^[1-7]/, '');
                        }
                        if (Array.isArray(currentAuction)) {
                            const ourSide = (currentTurn === 'N' || currentTurn === 'S') ? ['N', 'S'] : ['E', 'W'];
                            for (let i = currentAuction.length - 1; i >= 0; i--) {
                                const b = currentAuction[i];
                                const tok = b?.token || '';
                                if (!/^[1-7]/.test(tok)) continue;
                                if (!ourSide.includes(b?.seat)) continue;
                                const suit = tok.replace(/^[1-7]/, '');
                                const oppSuitBefore = currentAuction.slice(0, i).some((opp) => {
                                    const t = opp?.token || 'PASS';
                                    if (!/^[1-7]/.test(t)) return false;
                                    return opponentSeats.includes(opp?.seat) && t.replace(/^[1-7]/, '') === suit;
                                });
                                if (oppSuitBefore) continue; // skip cues when deriving strain
                                return suit;
                            }
                        }
                        return null;
                    })();
                    const gameLevelFor = (s) => {
                        if (s === 'C' || s === 'D') return 5;
                        if (s === 'H' || s === 'S') return 4;
                        if (s === 'NT') return 4;
                        return 4;
                    };
                    const target = strain ? `${gameLevelFor(strain)}${strain === 'NT' ? 'NT' : strain}` : '4NT';
                    recommendedBid = new window.Bid(target);
                    explanation = 'Forcing over partner cue-bid';
                } else if (Array.isArray(currentAuction) && currentAuction.length) {
                    // Ultra-conservative fallback using only live auction: if partner's last bid
                    // matches an earlier opponent suit, treat it as a cue and force game.
                    const ourSide = (currentTurn === 'N' || currentTurn === 'S') ? ['N', 'S'] : ['E', 'W'];
                    const partnerIdx = (() => {
                        for (let i = currentAuction.length - 1; i >= 0; i--) {
                            const b = currentAuction[i];
                            if (b && b.seat === partnerSeat && b.token && b.token !== 'PASS') return i;
                        }
                        return -1;
                    })();
                    if (partnerIdx >= 0) {
                        const partnerBid = currentAuction[partnerIdx];
                        const suit = partnerBid.token.replace(/^[1-7]/, '');
                        if (suit && suit !== 'NT' && partnerBid.token !== 'X' && partnerBid.token !== 'XX') {
                            const oppSuitBefore = currentAuction.slice(0, partnerIdx).some((opp) => {
                                const t = opp?.token || 'PASS';
                                if (!/^[1-7]/.test(t)) return false;
                                return opponentSeats.includes(opp?.seat) && t.replace(/^[1-7]/, '') === suit;
                            });
                            if (oppSuitBefore) {
                                // Choose our most recent non-cue strain or default 4NT
                                const strain = (() => {
                                    for (let i = currentAuction.length - 1; i >= 0; i--) {
                                        const b = currentAuction[i];
                                        const tok = b?.token || '';
                                        if (!/^[1-7]/.test(tok)) continue;
                                        if (!ourSide.includes(b?.seat)) continue;
                                        const s = tok.replace(/^[1-7]/, '');
                                        const oppCue = currentAuction.slice(0, i).some((opp) => {
                                            const t = opp?.token || 'PASS';
                                            if (!/^[1-7]/.test(t)) return false;
                                            return opponentSeats.includes(opp?.seat) && t.replace(/^[1-7]/, '') === s;
                                        });
                                        if (oppCue) continue;
                                        return s;
                                    }
                                    return null;
                                })();
                                const gameLevelFor = (s) => {
                                    if (s === 'C' || s === 'D') return 5;
                                    if (s === 'H' || s === 'S') return 4;
                                    if (s === 'NT') return 4;
                                    return 4;
                                };
                                const target = strain ? `${gameLevelFor(strain)}${strain === 'NT' ? 'NT' : strain}` : '4NT';
                                recommendedBid = new window.Bid(target);
                                explanation = 'Forcing over partner cue-bid';
                            }
                        }
                    }
                }

                // Absolute fallback: if partner's latest contract (from history or live auction)
                // matches any opponent suit seen so far, force us to game even when seats or
                // cues were not recognized above (jsdom stubs can drop seat metadata).
                if (!partnerCueEntry && recommendedBid && recommendedBid.token === 'PASS') {
                    const findPartnerBid = () => {
                        const partnerSeat = partnerOf(currentTurn);
                        const fromHist = auctionHistory.slice().reverse().find(e => e && e.position === partnerSeat && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
                        if (fromHist) return { bid: fromHist.bid, seat: partnerSeat };
                        if (Array.isArray(currentAuction)) {
                            for (let i = currentAuction.length - 1; i >= 0; i--) {
                                const b = currentAuction[i];
                                if (b && b.seat === partnerSeat && /^[1-7][CDHS]$/.test(b.token || '')) return { bid: b, seat: partnerSeat };
                            }
                        }
                        return null;
                    };

                    const partnerLatest = findPartnerBid();
                    const cueSuit = partnerLatest ? (partnerLatest.bid.token || '').replace(/^[1-7]/, '') : null;
                    const seenOppSuit = cueSuit && auctionHistory.some(e => {
                        const tok = e?.bid?.token || '';
                        if (!/^[1-7]/.test(tok)) return false;
                        const suit = tok.replace(/^[1-7]/, '');
                        return suit === cueSuit && !sameSide(e.position, currentTurn);
                    });

                    auctionLog('Cue-force absolute fallback check', {
                        seat: currentTurn,
                        cueSuit,
                        seenOppSuit,
                        partnerLatestToken: partnerLatest?.bid?.token,
                        hist: auctionHistory.length,
                        live: currentAuction.length
                    });

                    if (cueSuit && seenOppSuit) {
                        const strain = (() => {
                            const lastOur = auctionHistory.slice().reverse().find(e => {
                                const tok = e?.bid?.token || '';
                                return sameSide(e.position, currentTurn) && /^[1-7]/.test(tok) && !isCueBidOfOpponentsSuit(e.position, e.bid, auctionHistory);
                            });
                            return lastOur ? lastOur.bid.token.replace(/^[1-7]/, '') : null;
                        })();
                        const gameLevelFor = (s) => {
                            if (s === 'C' || s === 'D') return 5;
                            if (s === 'H' || s === 'S') return 4;
                            if (s === 'NT') return 4;
                            return 4;
                        };
                        const target = strain ? `${gameLevelFor(strain)}${strain === 'NT' ? 'NT' : strain}` : '4NT';
                        recommendedBid = new window.Bid(target);
                        explanation = 'Forcing over partner cue-bid';
                    }
                }
            }
        } catch (_) { /* last-ditch cue force */ }

        auctionHistory.push({
            position: currentTurn,
            bid: recommendedBid,
            explanation: explanation
        });

        currentAuction.push(recommendedBid);
        addBidExplanation(currentTurn, recommendedBid, explanation);

        // Move to next turn
        advanceTurn();
        updateAuctionTable();
        updateAuctionStatus();

        // Check if auction is over
        auctionLog('Checking if auction is complete...');
        auctionLog('Current auction length:', currentAuction.length);
        auctionLog('Last 3 bids:', currentAuction.slice(-3).map(bid => bid.token || 'PASS'));

        if (isAuctionComplete()) {
            auctionLog('Auction is complete, ending...');
            endAuction();
        } else {
            auctionLog('Auction continues...');
            processTurn();
        }

    } catch (error) {
        console.error('Error making system bid:', error);
        // Make a pass bid as fallback
        const passBid = new window.Bid('PASS');
        try {
            if (system?.currentAuction) {
                if (!passBid.seat) passBid.seat = currentTurn;
                if (typeof system.currentAuction.add === 'function') {
                    system.currentAuction.add(passBid);
                } else if (Array.isArray(system.currentAuction.bids)) {
                    system.currentAuction.bids.push(passBid);
                    // Ensure seats are populated after direct push
                    if (typeof system.currentAuction.reseat === 'function' && system.currentAuction.dealer) {
                        try { system.currentAuction.reseat(system.currentAuction.dealer); } catch (_) { /* best-effort */ }
                    }
                }
            }
        } catch (_) { /* best-effort sync */ }
        auctionHistory.push({
            position: currentTurn,
            bid: passBid,
            explanation: 'System pass (error)'
        });
        currentAuction.push(passBid);
        addBidExplanation(currentTurn, passBid, 'System pass');
        advanceTurn();
        updateAuctionTable();
        processTurn();
    }
}

// Determine if a bid is a cue bid of opponents' suit based on auction history
function isCueBidOfOpponentsSuit(position, bid, history) {
    if (!bid || !bid.token) return false;
    const token = bid.token;
    const suit = token.replace(/^[1-7]/, ''); // extract suit part like C,D,H,S,NT
    if (suit === 'NT' || suit === 'X' || suit === 'XX') return false;

    const opponents = (position === 'N' || position === 'S') ? ['E', 'W'] : ['N', 'S'];
    let seenOpponentSuit = false;

    for (let i = 0; i < history.length; i++) {
        const entry = history[i];

        // Stop scanning once we reach the bid being tested; only consider prior opp bids
        if (entry && entry.bid === bid) {
            break;
        }

        const t = entry?.bid?.token || 'PASS';
        if (opponents.includes(entry?.position) && t !== 'PASS' && t !== 'X' && t !== 'XX') {
            const entrySuit = t.replace(/^[1-7]/, '');
            if (entrySuit === suit) {
                seenOpponentSuit = true;
                break;
            }
        }
    }

    return seenOpponentSuit;
}

// Identify Michaels cue-bid and return a descriptive explanation when appropriate
function detectMichaelsCueBid(position, bid, history, hand) {
    try {
        if (!bid || !bid.token) return null;
        const token = bid.token;
        const suit = token.replace(/^[1-7]/, '');
        if (suit === 'NT' || suit === 'X' || suit === 'XX') return null;
        // Get config
        const cfg = system?.conventions?.config?.competitive?.michaels || {};
        if (cfg.enabled === false) return null;

        // Find opponents' opening bid (first non-pass in history by opponents)
        const ourSide = (position === 'N' || position === 'S') ? ['N', 'S'] : ['E', 'W'];
        const oppSide = (position === 'N' || position === 'S') ? ['E', 'W'] : ['N', 'S'];
        const firstNonPass = history.find(e => {
            const t = e?.bid?.token || 'PASS';
            return oppSide.includes(e.position) && t !== 'PASS' && t !== 'X' && t !== 'XX';
        });
        if (!firstNonPass) return null;
        const openerTok = firstNonPass.bid.token;
        const openerSuit = openerTok.replace(/^[1-7]/, '');

        // Our bid must be a cue of opener's suit
        if (suit !== openerSuit) return null;

        // Check direct-only constraint: ensure our partnership has not taken any non-pass action and that
        // there are no other non-pass bids between opener and our current action except passes by others.
        if (cfg.direct_only) {
            let sawOpener = false;
            for (let i = 0; i < history.length; i++) {
                const e = history[i];
                const t = e?.bid?.token || 'PASS';
                if (!sawOpener) {
                    if (e === firstNonPass) {
                        sawOpener = true;
                    }
                    continue;
                }
                // Between opener and now: if our side made a non-pass, not direct
                if (ourSide.includes(e.position) && t !== 'PASS') return null;
                // If opponents made another non-pass (besides opener) before our cue, also not direct
                if (oppSide.includes(e.position) && t !== 'PASS' && e !== firstNonPass) return null;
            }
        }

        // If we have the hand, validate that shape matches Michaels requirements (5-5 patterns)
        if (hand && hand.lengths) {
            const len = hand.lengths;
            const hasMajors55 = (len.H >= 5 && len.S >= 5);
            const hasSpadesPlusMinor55 = (len.S >= 5 && (len.C >= 5 || len.D >= 5));
            const hasHeartsPlusMinor55 = (len.H >= 5 && (len.C >= 5 || len.D >= 5));
            if ((openerSuit === 'C' || openerSuit === 'D') && !hasMajors55) return null;
            if (openerSuit === 'H' && !hasSpadesPlusMinor55) return null;
            if (openerSuit === 'S' && !hasHeartsPlusMinor55) return null;
        }

        // Build explanation based on opener's suit
        if (openerSuit === 'C' || openerSuit === 'D') {
            const strength = cfg.strength === 'strong_only' ? 'strong only' : 'wide range';
            return `Michaels cue-bid: both majors (5-5), ${strength}`;
        }
        if (openerSuit === 'H') {
            const strength = cfg.strength === 'strong_only' ? 'strong only' : 'wide range';
            return `Michaels cue-bid: spades + a minor (5-5), ${strength}`;
        }
        if (openerSuit === 'S') {
            const strength = cfg.strength === 'strong_only' ? 'strong only' : 'wide range';
            return `Michaels cue-bid: hearts + a minor (5-5), ${strength}`;
        }
        return null;
    } catch (_) {
        return null;
    }
}

// Check if responder (North) should raise to game after opener's 2NT
function shouldRaiseToGameAfterOpener2NT(hand, history) {
    if (!hand) return false;
    // Find last two non-pass bids and who made the 2NT
    let lastByS = null;
    for (let i = history.length - 1; i >= 0; i--) {
        const e = history[i];
        const tok = e?.bid?.token || 'PASS';
        if (tok !== 'PASS' && tok !== 'X' && tok !== 'XX') {
            if (e.position === 'S') {
                lastByS = tok;
                break;
            }
        }
    }
    if (lastByS !== '2NT') return false;
    // Use a simple threshold to push to game
    return (hand.hcp || 0) >= 12;
}

function getRecommendedBid() {
    try {
        // suppressed noisy diagnostics in UI/tests
        // Be permissive when currentTurn is unset (e.g., jsdom tests). Only block if it's explicitly not South.
        if ((currentTurn && currentTurn !== 'S') || !currentHands.S) {
            alert('Not your turn or no hand available');
            auctionLog('getRecommendedBid: BLOCKED - not South turn or no hand');
            return;
        }
        // Ensure dealer is always defined when syncing to engine
        const dealerSeat = dealer || (document.getElementById('dealer')?.value || 'S');
        // suppressed noisy diagnostics in UI/tests

        // Get system recommendation - use current system auction state
        if (!system.currentAuction || system.currentAuction.bids.length !== currentAuction.length) {
            // suppressed noisy diagnostics in UI/tests
            if (typeof system.startAuctionWithDealer !== 'function') {
                system.startAuctionWithDealer = function (ourSeat, dealerSeat, vulNS, vulEW) {
                    this.startAuction(ourSeat, /*we*/ vulNS, /*they*/ vulEW);
                    if (this.currentAuction && typeof this.currentAuction.reseat === 'function') {
                        this.currentAuction.reseat(dealerSeat);
                    } else if (this.currentAuction) {
                        this.currentAuction.dealer = dealerSeat;
                    }
                };
            }
            system.startAuctionWithDealer('S', dealerSeat, vulnerability.ns, vulnerability.ew);
            // Ensure dealer is set, then add via Auction.add for seat assignment
            if (typeof system.currentAuction.reseat === 'function') {
                system.currentAuction.reseat(dealerSeat);
            } else {
                system.currentAuction.dealer = dealerSeat;
            }
            currentAuction.forEach(bid => {
                try { system.currentAuction.add(bid); }
                catch (_) {
                    system.currentAuction.bids.push(bid);
                    try { system.currentAuction.reseat(dealerSeat); } catch { /* noop */ }
                }
            });
        } else {
            // Keep vulnerability in sync even when reusing the auction object
            try {
                system.currentAuction.weVulnerable = vulnerability.ns;
                system.currentAuction.theyVulnerable = vulnerability.ew;
            } catch (_) { /* noop */ }
        }
        // Always evaluate recommendation from South's perspective
        try { if (system.currentAuction) system.currentAuction.ourSeat = 'S'; } catch (_) { }

        const recommendedBid = system.getBid(currentHands.S);
        // Derive a full textual explanation consistent with the explanations panel. Prefer the seated auction.
        let explanation = recommendedBid.conventionUsed || '';
        try {
            if (typeof system.getExplanationFor === 'function') {
                const expl = system.getExplanationFor(recommendedBid, system.currentAuction || currentAuction);
                if (expl && !isGenericExplanationLabel(expl)) explanation = expl;
            }
        } catch (_) { /* fallback below */ }
        if (!explanation) explanation = '';

        // Normalize hint explanations to the actual bid token
        explanation = normalizeExplanationForBid(recommendedBid, explanation, system.currentAuction, 'S');
        // suppressed noisy diagnostics in UI/tests

        // Handle null token (which means Pass). If token is null (engine didn't
        // find a path and is effectively forced to pass), attempt to use the
        // trained model as a fallback. This is non-blocking: the UI will be
        // updated when the prediction resolves. The model integration is
        // defensive — if TF or the files are unavailable, nothing changes.
        const bidDisplay = recommendedBid.token || 'PASS';
        if ((recommendedBid.token === null || recommendedBid.token === undefined) && !forcedBid) {
            // Kick off async model prediction; update the UI when available.
            predictBidFromModel(currentHands.S, system.currentAuction).then(predTok => {
                if (!predTok) return; // no prediction available
                try {
                    // Clear convention explanation per your request so you can
                    // later inspect why engine couldn't find a path.
                    const modelBidDisplay = predTok;
                    const modelExplanation = '';
                    // Update legacy panel if present
                    const panelBid = document.getElementById('recommendedBidDisplay');
                    const panelReason = document.getElementById('recommendationReason');
                    const panelWrap = document.getElementById('recommendationResult');
                    if (panelBid && panelReason && panelWrap) {
                        panelBid.innerHTML = `<span class="bid-level">${modelBidDisplay}</span>`;
                        panelReason.textContent = modelExplanation;
                        panelWrap.style.display = 'block';
                    } else {
                        // Update inline hint
                        try { showInlineHintChip(modelBidDisplay, modelExplanation); } catch (_) { }
                    }
                } catch (_) { /* ignore UI update failures */ }
            }).catch(() => {/* ignore prediction errors */ });
        }

        // Display recommendation if the legacy panel exists; otherwise show an inline hint near the status
        const panelBid = document.getElementById('recommendedBidDisplay');
        const panelReason = document.getElementById('recommendationReason');
        const panelWrap = document.getElementById('recommendationResult');
        auctionLog('getRecommendedBid: panel elements exist=', !!panelBid, !!panelReason, !!panelWrap);
        if (panelBid && panelReason && panelWrap) {
            panelBid.innerHTML = `<span class="bid-level">${bidDisplay}</span>`;
            panelReason.textContent = explanation;
            panelWrap.style.display = 'block';
            auctionLog('getRecommendedBid: Updated legacy panel');
        } else {
            auctionLog('getRecommendedBid: Calling showInlineHintChip');
            try { showInlineHintChip(bidDisplay, explanation); }
            catch (e) {
                auctionLog('getRecommendedBid: showInlineHintChip failed:', e.message);
                alert(`Hint: ${bidDisplay}`);
            }
        }

    } catch (error) {
        console.error('Error getting recommendation:', error);
        alert('Error getting recommendation: ' + error.message);
    }
}

// Small helper to show a persistent inline hint chip in the auction status
function showInlineHintChip(bidDisplay, explanation) {
    const status = document.getElementById('auctionStatus');
    const hintBtn = document.getElementById('hintBtn');
    if (!status) throw new Error('status-missing');
    // Remove any existing inline hint first
    const old = document.getElementById('inlineHint');
    if (old && old.parentElement) old.parentElement.removeChild(old);
    const span = document.createElement('span');
    span.id = 'inlineHint';
    span.className = 'hint-inline';
    const trimmedBid = (bidDisplay || '').trim().toUpperCase();
    const trimmedExplanation = (explanation || '').trim();
    // Avoid duplicating "Pass" as both bid and explanation; keep explanation blank in that case.
    const shownExplanation = (trimmedBid === 'PASS' && trimmedExplanation.toLowerCase() === 'pass')
        ? ''
        : trimmedExplanation;
    span.title = shownExplanation || '';
    span.innerHTML = `<span class="hint-bid">Hint: ${bidDisplay}</span><span class="hint-expl">${shownExplanation}</span>`;
    // Insert before the button if present; else append at end
    if (hintBtn && hintBtn.parentElement === status) {
        status.insertBefore(span, hintBtn);
    } else {
        status.appendChild(span);
    }
}

// Ensure key routines remain reachable when this script is loaded via CommonJS (e.g., Jest tests)
try {
    if (typeof window !== 'undefined') {
        window.getRecommendedBid = getRecommendedBid;
        window.showInlineHintChip = showInlineHintChip;
    }
} catch (_) { /* no-op */ }

// Utility Functions
function createDeck() {
    const suits = ['S', 'H', 'D', 'C'];
    const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
    const deck = [];

    suits.forEach(suit => {
        ranks.forEach(rank => {
            deck.push(rank + suit);
        });
    });

    return deck;
}

/**
 * Predict a fallback bid using the trained model in `models/bid_model.json`.
 * Returns a Promise that resolves to a bid token (e.g., '1H','2NT','PASS') or
 * null if prediction is unavailable. This helper is defensive: it will try to
 * use an available TensorFlow runtime (browser `tf` or Node `@tensorflow/tfjs-node`).
 */
async function predictBidFromModel(hand, auction) {
    try {
        // Load tokens mapping
        let tokens = null;
        try {
            // Try synchronous require for Node/CommonJS tests
            const path = require('path');
            const fs = require('fs');
            const tokPath = path.join(process.cwd(), 'models', 'bid_tokens.json');
            if (fs.existsSync(tokPath)) tokens = JSON.parse(fs.readFileSync(tokPath, 'utf8'));
        } catch (e) {
            // Browser/env fallback: fetch if available
            try {
                const resp = await fetch('/models/bid_tokens.json');
                if (resp && resp.ok) tokens = await resp.json();
            } catch (_) { tokens = null; }
        }

        if (!tokens || !Array.isArray(tokens)) return null;

        // Try to obtain a TensorFlow runtime
        let tf = null;
        if (typeof window !== 'undefined' && window.tf) tf = window.tf;
        else {
            try {
                // Try Node.js TF if available
                tf = require('@tensorflow/tfjs-node');
            } catch (_) {
                try { tf = require('@tensorflow/tfjs'); } catch (_) { tf = null; }
            }
        }
        if (!tf || typeof tf.loadLayersModel !== 'function') return null;

        // Load the model. In Node, use file:// path; in browser try absolute path.
        let model = null;
        try {
            if (typeof window !== 'undefined' && window.location && !window.location.protocol.startsWith('file')) {
                model = await tf.loadLayersModel('/models/bid_model.json');
            } else {
                // Node environment: load from filesystem
                const modelPath = 'file://' + (require('path').join(process.cwd(), 'models', 'bid_model.json'));
                model = await tf.loadLayersModel(modelPath);
            }
        } catch (e) {
            return null;
        }

        // Prepare input vector. The exact encoder used during training may vary;
        // if an application-specific encoder exists (window.encodeHandAndAuction), use it.
        let inputVec = null;
        try {
            if (typeof window !== 'undefined' && typeof window.encodeHandAndAuction === 'function') {
                inputVec = window.encodeHandAndAuction(hand, auction);
            } else if (typeof encodeHandAndAuction === 'function') {
                inputVec = encodeHandAndAuction(hand, auction);
            }
        } catch (_) { inputVec = null; }

        // Fallback: create a zero-vector with expected size if we can't encode.
        // The model used during training has input shape 181; if different, try to
        // adapt gracefully by inspecting model.input.shape.
        let inputShape = 181;
        try { if (model && model.inputs && model.inputs[0] && model.inputs[0].shape) inputShape = model.inputs[0].shape[1] || inputShape; } catch (_) { }
        if (!inputVec || !Array.isArray(inputVec) || inputVec.length !== inputShape) {
            inputVec = new Array(inputShape).fill(0);
        }

        // Run prediction
        let tensor = tf.tensor([inputVec], [1, inputVec.length], 'float32');
        let out = model.predict(tensor);
        // Normalize output handling both tensor and array-like returns
        let probs = null;
        if (Array.isArray(out)) out = out[0];
        if (out && typeof out.data === 'function') probs = await out.data();
        else if (Array.isArray(out)) probs = out;
        if (!probs) return null;

        // Pick argmax
        let maxIdx = 0; let maxV = -Infinity;
        for (let i = 0; i < probs.length; i++) { if (probs[i] > maxV) { maxV = probs[i]; maxIdx = i; } }
        const predToken = tokens[maxIdx] || null;
        return predToken;
    } catch (err) {
        return null;
    }
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function convertCardsToHandString(cards) {
    // Convert array of cards like ["AS", "KH", "QD", "JC"] to "AK QJ - -" format
    const suits = { S: [], H: [], D: [], C: [] };

    cards.forEach(card => {
        const rank = card.slice(0, -1);
        const suit = card.slice(-1);
        suits[suit].push(rank);
    });

    // Sort each suit by rank (A, K, Q, J, T, 9, 8, 7, 6, 5, 4, 3, 2)
    const rankOrder = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
    Object.keys(suits).forEach(suit => {
        suits[suit].sort((a, b) => rankOrder.indexOf(a) - rankOrder.indexOf(b));
    });

    // Create the hand string format: "Spades Hearts Diamonds Clubs"
    return [
        suits.S.join('') || '-',
        suits.H.join('') || '-',
        suits.D.join('') || '-',
        suits.C.join('') || '-'
    ].join(' ');
}

function getSouthCards() {
    if (!currentHands.S) return [];
    const cards = [];
    ['S', 'H', 'D', 'C'].forEach(suit => {
        if (currentHands.S.suits[suit]) {
            currentHands.S.suits[suit].forEach(card => {
                cards.push(card);
            });
        }
    });
    return cards;
}

function calculateShortnessPoints(hand) {
    // Shortness points: 3-2-1 for voids, singletons, doubletons
    let points = 0;
    Object.values(hand.lengths).forEach(length => {
        if (length === 0) points += 3;      // void
        else if (length === 1) points += 2; // singleton  
        else if (length === 2) points += 1; // doubleton
    });
    return points;
}

function getSeatNumber(position) {
    const seats = { N: 0, E: 1, S: 2, W: 3 };
    return seats[position];
}

function advanceTurn() {
    const order = ['N', 'E', 'S', 'W'];
    const currentIndex = order.indexOf(currentTurn);
    currentTurn = order[(currentIndex + 1) % 4];
}

function endAuction() {
    try {
        const auctionContent = document.getElementById('auctionContent');
        if (auctionContent) auctionContent.style.display = 'block';
    } catch (_) { }

    // Stop capturing auction console output (we capture while auction is active)
    try { stopAuctionConsoleCapture(); } catch (_) { }

    // Update auction status if it exists (preserve flex layout)
    const auctionStatus = document.getElementById('auctionStatus');
    if (auctionStatus) {
        // Normalize classes and content
        try {
            auctionStatus.classList.remove('alert-info');
            auctionStatus.classList.add('alert', 'alert-warning', 'auction-status-flex');
        } catch (_) { }
        // Remove any inline hint chip from active-auction UI
        try { const ih = document.getElementById('inlineHint'); if (ih) ih.remove(); } catch (_) { }
        auctionStatus.innerHTML = '<span class="status-text">Auction Ended</span>';
    }

    // Disable bid buttons now that auction is over
    try { setAllBidButtonsDisabled(true); } catch (_) { }

    // Show Start Auction button to allow restart (after optional dealer/vul changes)
    const startAuctionBtn = document.getElementById('startAuctionBtn');
    if (startAuctionBtn) {
        startAuctionBtn.style.display = 'inline-block';
    }

    // Add final auction result to the table
    try {
        const auctionGrid = document.querySelector('.auction-grid');
        if (auctionGrid) {
            const resultRow = document.createElement('div');
            resultRow.className = 'auction-result';
            resultRow.style.gridColumn = '1 / -1';
            resultRow.style.textAlign = 'center';
            resultRow.style.fontWeight = 'bold';
            resultRow.style.padding = '10px';
            resultRow.style.backgroundColor = '#f8f9fa';
            resultRow.style.border = '2px solid #28a745';
            resultRow.style.marginTop = '10px';
            resultRow.textContent = 'AUCTION ENDED';
            auctionGrid.appendChild(resultRow);

            // Add final contract banner with x/xx if applicable
            const details = computePlayDetailsFromAuction();
            const banner = document.createElement('div');
            banner.className = 'auction-result';
            banner.style.gridColumn = '1 / -1';
            banner.style.textAlign = 'center';
            banner.style.fontWeight = '700';
            banner.style.padding = '8px';
            banner.style.backgroundColor = '#fff';
            banner.style.border = '1px solid #ced4da';
            banner.style.marginTop = '6px';
            if (!details.contract) {
                banner.textContent = 'Final Contract: All Pass';
            } else {
                const den = details.contract.strain === 'NT' ? 'NT' : ({ S: '♠', H: '♥', D: '♦', C: '♣' }[details.contract.strain] || details.contract.strain);
                const dblTxt = details.contract.dbl === 1 ? ' x' : (details.contract.dbl === 2 ? ' xx' : '');
                const sideTxt = details.contractSide === 'NS' ? 'N-S' : 'E-W';
                banner.textContent = `Final Contract: ${details.contract.level}${den}${dblTxt} by ${getTurnName(details.declarer)} (${sideTxt})`;
            }
            auctionGrid.appendChild(banner);
        }
    } catch (error) {
        auctionLog('Could not add auction ended message:', error.message);
    }

    auctionLog('Auction ended');

    // Repurpose Hint button to allow user-triggered transition to Play
    try {
        let hintBtn = document.getElementById('hintBtn');
        if (!hintBtn) {
            // If the Hint button was removed earlier, recreate it now
            hintBtn = document.createElement('button');
            hintBtn.id = 'hintBtn';
            hintBtn.className = 'main-btn compact danger';
        }
        hintBtn.textContent = 'Play the Hand';
        // Ensure it appears as the primary red action and is visible
        hintBtn.classList.remove('secondary', 'success');
        hintBtn.classList.add('danger');
        hintBtn.style.display = 'inline-block';
        // Use a small helper that guarantees both navigation and rendering
        hintBtn.setAttribute('onclick', 'goToPlay()');
        // Place it to the right within the status line
        if (auctionStatus) auctionStatus.appendChild(hintBtn);
    } catch (e) {
        console.warn('Failed to repurpose Hint button:', e?.message || e);
    }

    // Update Play tab state now that auction ended
    try { updatePlayTabState(); } catch (_) { }

    // Do not auto-switch to Play; user will click the repurposed Hint button ("Play the Hand")
    // Keeping the transition manual per UX requirement.
}

function updateAuctionHeaders() {
    const auctionGrid = document.querySelector('.auction-grid');
    if (!auctionGrid) return;

    // Get dealer-clockwise order
    const positions = ['W', 'N', 'E', 'S'];
    const dealerIndex = positions.indexOf(dealer);
    const orderedPositions = [];

    for (let i = 0; i < 4; i++) {
        orderedPositions.push(positions[(dealerIndex + i) % 4]);
    }

    // Update headers
    const headers = auctionGrid.querySelectorAll('.auction-position');
    orderedPositions.forEach((pos, index) => {
        if (headers[index]) {
            const posName = getTurnName(pos);
            if (index === 0) {
                headers[index].innerHTML = `${posName} (dealer)`;
            } else {
                headers[index].innerHTML = posName;
            }
        }
    });
}

function updateAuctionTable() {
    const auctionBids = document.getElementById('auctionBids');

    if (!auctionBids) {
        console.error('auctionBids element not found');
        return;
    }

    // Update headers to show dealer first
    updateAuctionHeaders();

    auctionBids.innerHTML = '';

    if (auctionHistory.length === 0) {
        auctionBids.innerHTML = '<div class="text-muted">Auction starting...</div>';
        return;
    }

    // Group bids by rounds
    const rounds = [];
    let currentRound = [];
    let expectedPosition = dealer;

    auctionHistory.forEach(entry => {
        if (entry.position === expectedPosition && currentRound.length === 0) {
            // Start of new round
            currentRound = [entry];
        } else {
            currentRound.push(entry);
        }

        if (currentRound.length === 4) {
            rounds.push(currentRound);
            currentRound = [];
        }

        // Advance expected position
        const order = ['W', 'N', 'E', 'S'];
        const index = order.indexOf(expectedPosition);
        expectedPosition = order[(index + 1) % 4];
    });

    if (currentRound.length > 0) {
        rounds.push(currentRound);
    }

    // Display rounds - use dealer-clockwise order
    const positions = ['W', 'N', 'E', 'S'];
    const dealerIndex = positions.indexOf(dealer);
    const orderedPositions = [];

    for (let i = 0; i < 4; i++) {
        orderedPositions.push(positions[(dealerIndex + i) % 4]);
    }

    rounds.forEach(round => {
        const roundDiv = document.createElement('div');
        roundDiv.className = 'auction-round';

        orderedPositions.forEach(pos => {
            const bidDiv = document.createElement('div');
            bidDiv.className = 'auction-bid';
            const entry = round.find(e => e.position === pos);
            if (entry) {
                const bidToken = entry.bid.token || 'PASS';
                let alertable = false;
                try {
                    alertable = isAlertableExplanation(entry.explanation) && !['PASS', 'X', 'XX'].includes(bidToken);
                } catch (_) { /* noop */ }
                // Base formatted bid (with suit color and alert marker)
                let html = formatBidForAuction(bidToken, alertable);
                // Small UI hint for 2NT: Natural vs Unusual (based on explanation text)
                try {
                    const expl = (entry.explanation || '').toLowerCase();
                    if (bidToken === '2NT' && expl) {
                        if (expl.includes('unusual nt')) {
                            html += ' <span class="bid-tag unusual" title="Unusual 2NT — minors, 5-5">U</span>';
                        } else if (expl.includes('natural 2nt overcall')) {
                            html += ' <span class="bid-tag natural" title="Natural 2NT — 19–21 balanced with stopper">N</span>';
                        }
                    }
                    // Tooltip with explanation (suppress tooltips for PASS bids)
                    if (entry.explanation && bidToken !== 'PASS') {
                        bidDiv.title = entry.explanation;
                    }
                } catch (_) { /* ignore tooltip/hint issues */ }
                bidDiv.innerHTML = html;
            } else {
                bidDiv.innerHTML = '-';
            }
            roundDiv.appendChild(bidDiv);
        });
        auctionBids.appendChild(roundDiv);
    });
}

function updateAuctionStatus() {
    const status = document.getElementById('auctionStatus');
    if (auctionActive) {
        const turnName = getTurnName(currentTurn);
        // Make the status container flex via CSS class so we can place the existing Hint button on the right
        try { status.classList.add('auction-status-flex'); } catch (_) { }

        // Preserve (or recreate) the Hint button BEFORE resetting innerHTML to avoid nuking it
        let hintBtn = document.getElementById('hintBtn');
        if (!hintBtn) {
            // Recreate a Hint button if it was removed by a previous innerHTML call
            hintBtn = document.createElement('button');
            hintBtn.id = 'hintBtn';
            hintBtn.className = 'main-btn compact danger';
            hintBtn.textContent = 'Hint';
            hintBtn.setAttribute('onclick', 'getRecommendedBid()');
        }

        // Refresh the left-side status text (this clears previous children)
        status.innerHTML = `<span class="status-text">${turnName} to bid</span>`;

        // Normalize and show the Hint button, then append to the right side
        try {
            if (hintBtn) {
                hintBtn.classList.remove('secondary', 'success');
                hintBtn.classList.add('danger');
                hintBtn.textContent = 'Hint';
                hintBtn.setAttribute('onclick', 'getRecommendedBid()');
                hintBtn.style.display = 'inline-block';
                status.appendChild(hintBtn);
            }
        } catch (_) { }
    }
}

// removed dynamic Hint button logic

function getTurnName(position) {
    const names = { N: 'North', E: 'East', S: 'South (You)', W: 'West' };
    return names[position];
}

// Determine if a bid's explanation implies an alertable convention
function isAlertableExplanation(explanation) {
    if (!explanation || typeof explanation !== 'string') return false;
    const txt = explanation.toLowerCase();
    // Common alertable/conventional phrases
    const needles = [
        'stayman', 'transfer', 'texas', 'gerber', 'blackwood', 'rkcb',
        'splinter', 'drury', 'jacoby 2nt', 'minor suit transfer', 'mst',
        'support double', 'negative double', 'responsive double', 'reopening double',
        'michaels', 'unusual nt', 'cue bid', 'cue bid raise',
        'weak two', 'feature ask', 'ogust', 'quantitative', 'control showing cue bid',
        'strong 2 club', 'strong 2c', 'waiting response', 'positive response',
        'bergen'
    ];
    return needles.some(n => txt.includes(n));
}

// Render a suit symbol for the auction grid (neutral, no color)
function renderSuitSpan(suitLetter) {
    const map = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
    const classMap = { 'S': 'suit-spades', 'H': 'suit-hearts', 'D': 'suit-diamonds', 'C': 'suit-clubs' };
    const symbol = map[suitLetter];
    if (!symbol) return '';
    // Apply suit-specific color classes so icons render in standard colors
    const cls = `card-suit ${classMap[suitLetter] || ''}`;
    return `<span class="${cls}">${symbol}</span>`;
}

// Format a bid token into HTML with suit symbols/colors and optional alert marker
function formatBidForAuction(token, alertable) {
    const t = token || 'PASS';
    if (t === 'PASS' || t === 'X' || t === 'XX') {
        return `<strong>${t}</strong>`;
    }
    // Handle NT bids as plain text (no suit color)
    if (t.endsWith('NT')) {
        return `<strong>${t}${alertable ? '!' : ''}</strong>`;
    }
    // Suit bids: level followed by suit letter
    const level = t.charAt(0);
    const denom = t.slice(1);
    if (['S', 'H', 'D', 'C'].includes(denom)) {
        return `<strong>${level}${renderSuitSpan(denom)}${alertable ? '!' : ''}</strong>`;
    }
    // Fallback: just show as text
    return `<strong>${t}${alertable ? '!' : ''}</strong>`;
}

function updateBidButtons() {
    // Enable/disable bid buttons based on auction state
    auctionLog('updateBidButtons called');
    // If it's not user's turn, keep everything disabled
    if (currentTurn !== 'S') {
        try { setAllBidButtonsDisabled(true); } catch (_) { }
        return;
    }

    // Helper to ask engine if a bid is legal in the current auction
    const isEngineLegal = (bidText) => {
        try {
            if (!system || typeof system.isLegal !== 'function') return true; // fallback
            if (bidText === 'PASS') return true;
            if (bidText === 'X') {
                return system.isLegal(new window.Bid(null, { isDouble: true }));
            }
            if (bidText === 'XX') {
                return system.isLegal(new window.Bid(null, { isRedouble: true }));
            }
            return system.isLegal(new window.Bid(bidText));
        } catch (_) {
            return true; // be permissive on UI helper failure
        }
    };

    // Update all bid buttons - enable only legal ones, and highlight legal actions
    document.querySelectorAll('.bid-button').forEach(btn => {
        const onclickAttr = btn.getAttribute('onclick');
        if (!onclickAttr || !onclickAttr.includes('makeBid')) return;
        const match = onclickAttr.match(/makeBid\('(.+?)'\)/);
        const bidText = match ? match[1] : null;
        if (!bidText) return;
        // Only apply partner guards when a prior contract exists; otherwise allow engine legality to drive initial state
        const hasPriorContract = !!getLastNonPassBidWithPosition();
        const partnerGuard = (bidText === 'X')
            ? (!hasPriorContract || canDouble())
            : (bidText === 'XX')
                ? (!hasPriorContract || canRedouble())
                : true;
        const legal = isEngineLegal(bidText) && partnerGuard;
        btn.disabled = !legal;
        // Visual cue: legal bid buttons get a light blue background
        if (legal) btn.classList.add('legal-bid'); else btn.classList.remove('legal-bid');
    });

    // Update special buttons using engine legality
    const doubleBtn = document.getElementById('doubleBtn');
    if (doubleBtn) {
        const hasPriorContract = !!getLastNonPassBidWithPosition();
        const legalX = isEngineLegal('X') && (!hasPriorContract || canDouble());
        doubleBtn.disabled = !legalX;
        if (legalX) doubleBtn.classList.add('legal-bid'); else doubleBtn.classList.remove('legal-bid');
    }
    const redoubleBtn = document.getElementById('redoubleBtn');
    if (redoubleBtn) {
        const hasPriorContract = !!getLastNonPassBidWithPosition();
        const legalXX = isEngineLegal('XX') && (!hasPriorContract || canRedouble());
        redoubleBtn.disabled = !legalXX;
        if (legalXX) redoubleBtn.classList.add('legal-bid'); else redoubleBtn.classList.remove('legal-bid');
    }
}

function setAllBidButtonsDisabled(disabled) {
    document.querySelectorAll('.bid-button').forEach(btn => btn.disabled = !!disabled);
}

function getLastNonPassBid() {
    auctionLog('getLastNonPassBid called, currentAuction length:', currentAuction.length);
    for (let i = currentAuction.length - 1; i >= 0; i--) {
        const bid = currentAuction[i];
        auctionLog(`Checking bid ${i}:`, bid, 'token:', bid?.token);
        const bidToken = bid?.token || 'PASS';
        if (bidToken !== 'PASS' && bidToken !== 'X' && bidToken !== 'XX') {
            auctionLog('Found last non-pass bid:', bid);
            return bid;
        }
    }
    auctionLog('No non-pass bid found, returning null');
    return null;
}

function isAuctionComplete() {
    // Auction is complete when there are three consecutive PASSes at the end
    // Normal rule: auction ends when there are three consecutive PASSes after a non-pass bid.
    // Special-case: when there have been no non-pass bids at all (i.e., everyone passing),
    // require four initial passes to end the auction so the last player also gets to act.
    if (!Array.isArray(currentAuction) || currentAuction.length === 0) return false;
    const tokens = currentAuction.map(b => (b && b.token) ? b.token : 'PASS');
    const hasNonPass = tokens.some(t => t && t.toUpperCase() !== 'PASS');
    if (hasNonPass) {
        return (tokens.length >= 3 && tokens.slice(-3).every(t => t === 'PASS'));
    }
    // No non-pass bids yet: require four passes to conclude the auction
    return (tokens.length >= 4 && tokens.slice(-4).every(t => t === 'PASS'));
}

function isValidBid(bidString, lastBid) {
    if (bidString === 'PASS') return true;

    // Use the passed lastBid parameter consistently
    if (!lastBid) {
        // No previous non-pass bids - any opening bid is valid
        return true;
    }

    // Compare bid levels for sufficient bids
    try {
        const newBid = new window.Bid(bidString);

        // Derive level/suit when missing (e.g., in tests with simple stubs)
        const parseParts = (b) => {
            const tok = (typeof b === 'string') ? b : (b?.token || '');
            const m = /^([1-7])(C|D|H|S|NT)$/.exec(tok);
            if (m) return { level: parseInt(m[1], 10), suit: m[2] };
            return { level: Number.NEGATIVE_INFINITY, suit: null };
        };
        const nb = {
            level: (newBid.level != null) ? newBid.level : parseParts(newBid).level,
            suit: newBid.suit || parseParts(newBid).suit
        };
        const lb = {
            level: (lastBid.level != null) ? lastBid.level : parseParts(lastBid).level,
            suit: lastBid.suit || parseParts(lastBid).suit
        };

        // Must be higher level or same level with higher suit
        const isHigherLevel = nb.level > lb.level;
        const isSameLevelHigherSuit = (nb.level === lb.level &&
            getSuitRank(nb.suit) > getSuitRank(lb.suit));

        return isHigherLevel || isSameLevelHigherSuit;
    } catch (e) {
        return false;
    }
}

function getSuitRank(suit) {
    const ranks = { 'C': 1, 'D': 2, 'H': 3, 'S': 4, 'NT': 5 };
    return ranks[suit] || 0;
}

function getLastNonPassBidWithPosition() {
    // Returns the last non-pass bid along with the position who made it
    for (let i = currentAuction.length - 1; i >= 0; i--) {
        const bid = currentAuction[i];
        const entry = auctionHistory[i];
        const token = bid.token || 'PASS';
        if (token !== 'PASS') {
            return { bid: bid, position: entry.position };
        }
    }
    return null;
}

function isOpponentPosition(position, ourPosition) {
    // Check if the given position is an opponent of ourPosition
    const partnerships = {
        'N': ['N', 'S'], // North-South partnership
        'S': ['N', 'S'],
        'E': ['E', 'W'], // East-West partnership  
        'W': ['E', 'W']
    };

    const ourPartnership = partnerships[ourPosition];
    return !ourPartnership.includes(position);
}

function isValidSystemBid(bidString, position) {
    // Validate a bid for the system (computer players)
    if (bidString === 'PASS' || bidString === null) return true;

    // Doubles/redoubles have distinct legality rules; handle them before sufficiency checks
    if (bidString === 'X') {
        const lastNonPassBidWithPos = getLastNonPassBidWithPosition();
        if (!lastNonPassBidWithPos) return false;

        // Cannot double if already doubled or redoubled
        if (lastNonPassBidWithPos.bid.token === 'X' || lastNonPassBidWithPos.bid.token === 'XX') return false;

        // Can only double opponent's bid
        return isOpponentPosition(lastNonPassBidWithPos.position, position);
    }

    if (bidString === 'XX') {
        // Can redouble if last action was opponent's double
        for (let i = currentAuction.length - 1; i >= 0; i--) {
            const entry = auctionHistory[i];
            if (entry.bid.token === 'X') {
                return isOpponentPosition(entry.position, position);
            } else if (entry.bid.token !== 'PASS') {
                return false;
            }
        }
        return false;
    }

    // Check basic bid validity
    const lastNonPassBid = getLastNonPassBid();
    if (!isValidBid(bidString, lastNonPassBid)) {
        return false;
    }

    return true;
}

function canDouble() {
    // Can double if last non-pass bid was by opponents and not already doubled
    if (currentAuction.length === 0) return false;

    // Find the last non-pass bid and who made it
    const lastNonPassBid = getLastNonPassBidWithPosition();
    if (!lastNonPassBid) return false;

    // Cannot double if already doubled or redoubled
    if (lastNonPassBid.bid.token === 'X' || lastNonPassBid.bid.token === 'XX') return false;

    // Can only double opponent's bid, not partner's
    const isOpponent = isOpponentPosition(lastNonPassBid.position, 'S');

    return isOpponent;
}

function canRedouble() {
    // Can redouble if last action was a double by opponents
    if (currentAuction.length === 0) return false;

    // Look for the most recent double
    for (let i = currentAuction.length - 1; i >= 0; i--) {
        const entry = auctionHistory[i];
        if (entry.bid.token === 'X') {
            // Found a double - check if it was by opponent
            return isOpponentPosition(entry.position, 'S');
        } else if (entry.bid.token !== 'PASS') {
            // Found a non-pass, non-double bid - can't redouble
            return false;
        }
    }

    return false;
}

function addBidExplanation(position, bid, explanation) {
    const explanationsList = document.getElementById('explanationsList');

    if (!explanationsList) {
        console.error('explanationsList element not found');
        return;
    }

    const row = document.createElement('div');
    row.className = 'explanation-item';
    const bidDisplay = bid.token || 'PASS';
    // Determine side for styling: we (South), partner (North), opponents (East/West)
    const sideClass = (position === 'S') ? 'we' : (position === 'N' ? 'partner' : 'opponent');

    // If practicing a specific convention, annotate generic cue-bids accordingly (e.g., Michaels)
    try {
        const practiceTargets = (typeof window !== 'undefined' && Array.isArray(window.activePracticeTargets)) ? window.activePracticeTargets : (Array.isArray(activePracticeTargets) ? activePracticeTargets : []);
        if (practiceTargets.includes('Michaels')) {
            const isCue = isCueBidOfOpponentsSuit(position, bid, auctionHistory);
            const openerEntry = (auctionHistory || []).find(e => e && e.bid && /^[1-7][CDHS]$/.test(e.bid.token || ''));
            const openerSuit = openerEntry ? openerEntry.bid.token.replace(/^[1-7]/, '') : null;
            const openerSeat = openerEntry?.position || null;
            const openerNS = openerSeat ? (openerSeat === 'N' || openerSeat === 'S') : null;
            const bidderNS = (position === 'N' || position === 'S');
            const isOpponents = (openerNS === null) ? true : (openerNS !== bidderNS);
            const level = parseInt((bidDisplay || '')[0], 10) || 0;
            if (isCue && isOpponents && level === 2) {
                if (openerSuit === 'C' || openerSuit === 'D') {
                    explanation = 'Michaels cue-bid: 5-5 majors over a minor opening';
                } else if (openerSuit === 'H') {
                    explanation = 'Michaels cue-bid: spades + a minor (5-5) over 1H';
                } else if (openerSuit === 'S') {
                    explanation = 'Michaels cue-bid: hearts + a minor (5-5) over 1S';
                } else {
                    explanation = 'Michaels cue-bid: two-suited overcall';
                }
            }
        }
    } catch (_) { /* best-effort practice annotation */ }

    // Normalize explanation for direct 1-level suit overcalls to keep consistency
    try {
        const isOneLevelSuit = /^[1][CDHS]$/.test(bidDisplay);
        if (isOneLevelSuit) {
            // Inspect history prior to this bid
            const tokens = (auctionHistory || []).map(e => {
                const t = e?.bid?.token;
                if (t) return t;
                if (e?.bid?.isDouble) return 'X';
                if (e?.bid?.isRedouble) return 'XX';
                return 'PASS';
            });
            const currentIdx = tokens.length - 1; // this row's bid
            const prior = tokens.slice(0, currentIdx);
            // Count prior non-pass/non-double bids
            let nonPassCount = 0;
            let openerIdx = -1;
            for (let i = 0; i < prior.length; i++) {
                const t = prior[i];
                if (t !== 'PASS' && t !== 'X' && t !== 'XX') {
                    nonPassCount++;
                    if (openerIdx === -1) openerIdx = i;
                }
            }
            // Direct overcall context: exactly one prior non-pass bid and it was a 1-level suit opening
            if (nonPassCount === 1 && openerIdx >= 0 && /^1[CDHS]$/.test(prior[openerIdx])) {
                // Ensure this bid is by the opponents of the opener's side
                const openerPos = (auctionHistory && auctionHistory[openerIdx] && auctionHistory[openerIdx].position) || null;
                const openerSideNS = openerPos && (openerPos === 'N' || openerPos === 'S');
                const thisSideNS = (position === 'N' || position === 'S');
                const isOpponents = openerPos ? (openerSideNS !== thisSideNS) : true;
                if (isOpponents) {
                    const s = bidDisplay.slice(-1);
                    const suitNameMap = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };
                    const suitText = suitNameMap[s] || s;
                    explanation = `Overcall: natural 5+ ${suitText}`;
                }
            }
        }
    } catch (_) { /* best-effort normalization */ }

    // If explanation is generic and this is a jump to game in a major after partner previously bid that major, label it clearly
    try {
        const isGeneric = !explanation || isGenericExplanationLabel(explanation);
        if (isGeneric && /^4[HS]$/.test(bidDisplay)) {
            const suit = bidDisplay.slice(-1);
            const partnerSeat = (position === 'N') ? 'S' : (position === 'S' ? 'N' : (position === 'E' ? 'W' : 'E'));
            const priorSameSuitByPartner = (auctionHistory || []).some(e => {
                const tok = e?.bid?.token || 'PASS';
                if (e.position !== partnerSeat) return false;
                return new RegExp(`^[1-3]${suit}$`).test(tok);
            });
            if (priorSameSuitByPartner) {
                const nameMap = { H: 'hearts', S: 'spades' };
                explanation = `Raise to game in ${nameMap[suit]}`;
            }
        }
    } catch (_) { /* best-effort enhancement */ }

    // Cue-bid raise labeling: when we bid opponents' suit after partner has shown a suit
    try {
        const isCue = isCueBidOfOpponentsSuit(position, bid, auctionHistory);
        const isGenericCue = !explanation || isGenericExplanationLabel(explanation) || /Cue bid of opponents/i.test(explanation || '');
        if (isCue && isGenericCue) {
            const partnerSeat = partnerOf(position);
            const partnerSuitEntry = auctionHistory.slice().reverse().find(e => e.position === partnerSeat && /^[1-7][CDHS]$/.test(e?.bid?.token || ''));
            const partnerSuit = partnerSuitEntry ? partnerSuitEntry.bid.token.replace(/^[1-7]/, '') : null;
            if (partnerSuit) {
                const names = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };
                explanation = `Cue-bid raise showing support for partner's ${names[partnerSuit] || partnerSuit} (game-forcing)`;
            }
        }
    } catch (_) { /* best-effort cue labeling */ }

    // Strip generic placeholder labels before rendering to keep UI noise-free
    if (isGenericExplanationLabel(explanation)) {
        explanation = '';
    }
    // For PASS bids, suppress the trailing explanation text to reduce noise
    const explText = (bidDisplay === 'PASS') ? '' : (explanation || '');
    const badgeClass = getExplanationBadgeClass(explText);
    // Build: Who: <BID>. [Explanation]
    row.innerHTML = `
        <strong class="who">${getTurnName(position)}:</strong>
        <span class="bid-token ${sideClass}">${bidDisplay}.</span>
        ${explText ? `<span class="explanation-text explanation-badge ${badgeClass}">${explText}</span>` : ''}
    `;
    explanationsList.appendChild(row);

    // Keep a generous history so the panel matches the grid; allow up to 50 before trimming
    const MAX_EXPL = 50;
    while (explanationsList.children.length > MAX_EXPL) {
        explanationsList.removeChild(explanationsList.firstChild);
    }
}

// Lightweight classifier to add subtle badge styles to common convention explanations
function getExplanationBadgeClass(text) {
    try {
        if (!text || typeof text !== 'string') return '';
        const t = text.toLowerCase();
        if (t.includes('negative double')) return 'expl-neg-double';
        if (t.includes('support double')) return 'expl-support-double';
        if (t.includes('responsive double')) return 'expl-responsive-double';
        if (t.includes('reopening double')) return 'expl-responsive-double';
        if (t.includes('takeout double')) return 'expl-takeout-double';
        if (t.includes('michaels')) return 'expl-michaels';
        if (t.includes('unusual nt')) return 'expl-michaels';
        if (t.includes('lebensohl')) return 'expl-lebensohl';
        if (t.includes('cue bid raise')) return 'expl-cue-raise';
        if (t.includes('stayman') || t.includes('transfer')) return 'expl-stayman-transfer';
        if (t.includes('gerber') || t.includes('blackwood')) return 'expl-ace-asking';
    } catch (_) { /* noop */ }
    return '';
}





// Convention Management Functions
async function initializeConventionUI() {
    try {
        // Get available conventions from the loaded config
        await loadAvailableConventions();
        // Apply any persisted enabled/disabled choices for Active Conventions
        try {
            const persisted = loadPersistedEnabledConventions();
            if (persisted && typeof persisted === 'object') {
                Object.keys(persisted).forEach(name => {
                    if (availableConventions[name]) {
                        // Keep general conventions always enabled regardless of persisted value
                        if (availableConventions[name].isGeneral) {
                            enabledConventions[name] = true;
                        } else {
                            enabledConventions[name] = !!persisted[name];
                        }
                    }
                });
            }
        } catch (e) {
            console.warn('Failed to apply persisted enabled conventions:', e);
        }
        // Build General Settings (engine-wide toggles)
        createGeneralSettingsSection();
        createConventionCheckboxes();
        createPracticeConventionOptions();
        // Sync Active Conventions into engine configuration so bidding logic respects UI
        try { updateSystemConventions(); } catch (e) { console.warn('Failed to sync Active Conventions to engine:', e); }

        pageLog('Convention UI initialized successfully');
    } catch (error) {
        console.error('Error initializing convention UI:', error);
    }
}

// ---- General Settings: persistence helpers ----
const GENERAL_SETTINGS_STORAGE_KEY = 'bridge_general_settings_v1';
const ACTIVE_CONVENTIONS_STORAGE_KEY = 'bridge_enabled_conventions_v1';

function loadPersistedGeneralSettings() {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        const raw = window.localStorage.getItem(GENERAL_SETTINGS_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.warn('loadPersistedGeneralSettings failed:', e);
        return null;
    }
}

function saveGeneralSettings() {
    try {
        if (!system?.conventions?.config) return;
        const cfg = system.conventions.config;
        const snapshot = {
            include_5422: !!(cfg?.general?.balanced_shapes?.include_5422),
            vulnerability_adjustments: !!(cfg?.general?.vulnerability_adjustments),
            support_doubles_thru: (cfg?.competitive?.support_doubles?.thru) || '2S',
            responsive_doubles_thru: Number(cfg?.competitive?.responsive_doubles?.thru_level) || 3,
            michaels_strength: (cfg?.competitive?.michaels?.strength) || 'wide_range',
            unusual_nt_over_minors: !!(cfg?.notrump_defenses?.unusual_nt?.over_minors),
            relaxed_takeout: !!(cfg?.general?.relaxed_takeout_doubles),
            systems_on_over_1nt_interference: {
                // Back-compat: omit 'stayman' from persistence; if present from old store, we'll still read/apply it
                transfers: !!(cfg?.general?.systems_on_over_1nt_interference?.transfers),
                stolen_bid_double: !!(cfg?.general?.systems_on_over_1nt_interference?.stolen_bid_double)
            },
            nt_over_minors_range: (cfg?.general?.nt_over_minors_range) || 'classic',
            // UI preferences not part of engine config
            show_all_hands_by_default: (function () {
                try {
                    const el = document.getElementById('toggle_show_all_hands');
                    if (el) return !!el.checked;
                    const persisted = loadPersistedGeneralSettings();
                    if (persisted && typeof persisted.show_all_hands_by_default === 'boolean') {
                        return persisted.show_all_hands_by_default;
                    }
                } catch (_) { }
                return true; // default
            })(),
            dp_display_type: (function () {
                try {
                    const sel = document.getElementById('select_dp_display');
                    if (sel && (sel.value === 'shortness' || sel.value === 'length')) {
                        return sel.value;
                    }
                    const persisted = loadPersistedGeneralSettings();
                    if (persisted && (persisted.dp_display_type === 'shortness' || persisted.dp_display_type === 'length')) {
                        return persisted.dp_display_type;
                    }
                } catch (_) { }
                return 'shortness';
            })()
        };
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(GENERAL_SETTINGS_STORAGE_KEY, JSON.stringify(snapshot));
        }
    } catch (e) {
        console.warn('saveGeneralSettings failed:', e);
    }
}

// ---- Active Conventions: persistence helpers ----
function loadPersistedEnabledConventions() {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        const raw = window.localStorage.getItem(ACTIVE_CONVENTIONS_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.warn('loadPersistedEnabledConventions failed:', e);
        return null;
    }
}

function saveEnabledConventions() {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        // Persist only non-general conventions to keep storage minimal
        const snapshot = {};
        Object.keys(enabledConventions).forEach(name => {
            const meta = availableConventions[name];
            if (!meta || meta.isGeneral) return;
            snapshot[name] = !!enabledConventions[name];
        });
        window.localStorage.setItem(ACTIVE_CONVENTIONS_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (e) {
        console.warn('saveEnabledConventions failed:', e);
    }
}

function applyGeneralSettingsToConfig(settings) {
    try {
        if (!system?.conventions?.config) return;
        const cfg = system.conventions.config;
        cfg.general = cfg.general || {};
        cfg.general.balanced_shapes = cfg.general.balanced_shapes || { include_5422: false };
        if (typeof settings.include_5422 === 'boolean') cfg.general.balanced_shapes.include_5422 = settings.include_5422;
        if (typeof settings.vulnerability_adjustments === 'boolean') cfg.general.vulnerability_adjustments = settings.vulnerability_adjustments;
        if (typeof settings.relaxed_takeout === 'boolean') cfg.general.relaxed_takeout_doubles = settings.relaxed_takeout;
        if (settings.nt_over_minors_range === 'classic' || settings.nt_over_minors_range === 'wide') {
            cfg.general.nt_over_minors_range = settings.nt_over_minors_range;
        }

        // RKCB responses
        // RKCB response structure removed from General Settings; use engine default

        // Competitive settings
        cfg.competitive = cfg.competitive || {};
        cfg.competitive.support_doubles = cfg.competitive.support_doubles || { enabled: true };
        if (settings.support_doubles_thru) cfg.competitive.support_doubles.thru = settings.support_doubles_thru;
        cfg.competitive.responsive_doubles = cfg.competitive.responsive_doubles || { enabled: true };
        if (settings.responsive_doubles_thru) cfg.competitive.responsive_doubles.thru_level = Number(settings.responsive_doubles_thru);
        cfg.competitive.michaels = cfg.competitive.michaels || { enabled: true };
        if (settings.michaels_strength) cfg.competitive.michaels.strength = settings.michaels_strength;

        // Unusual NT over minors toggle
        cfg.notrump_defenses = cfg.notrump_defenses || {};
        cfg.notrump_defenses.unusual_nt = cfg.notrump_defenses.unusual_nt || { enabled: true, direct: true, passed_hand: false, over_minors: false };
        if (typeof settings.unusual_nt_over_minors === 'boolean') {
            cfg.notrump_defenses.unusual_nt.over_minors = settings.unusual_nt_over_minors;
        }

        // Systems-on over 1NT interference (general)
        cfg.general.systems_on_over_1nt_interference = cfg.general.systems_on_over_1nt_interference || {
            stayman: false,
            transfers: false,
            stolen_bid_double: false
        };
        if (settings.systems_on_over_1nt_interference && typeof settings.systems_on_over_1nt_interference === 'object') {
            const s = settings.systems_on_over_1nt_interference;
            if (typeof s.stayman === 'boolean') cfg.general.systems_on_over_1nt_interference.stayman = s.stayman;
            if (typeof s.transfers === 'boolean') cfg.general.systems_on_over_1nt_interference.transfers = s.transfers;
            if (typeof s.stolen_bid_double === 'boolean') cfg.general.systems_on_over_1nt_interference.stolen_bid_double = s.stolen_bid_double;
        }
    } catch (e) {
        console.warn('applyGeneralSettingsToConfig failed:', e);
    }
}

function createGeneralSettingsSection() {
    try {
        const container = document.getElementById('generalSettings');
        if (!container) return;

        const cfg = system?.conventions?.config || {};
        const include5422 = !!(cfg?.general?.balanced_shapes?.include_5422);
        const vulAdj = !!(cfg?.general?.vulnerability_adjustments);
        const relaxedTO = !!(cfg?.general?.relaxed_takeout_doubles);
        const persistedGS = loadPersistedGeneralSettings() || {};
        const showAllHandsDefault = (typeof persistedGS.show_all_hands_by_default === 'boolean') ? persistedGS.show_all_hands_by_default : true;
        const dpDisplayType = (persistedGS && (persistedGS.dp_display_type === 'length' || persistedGS.dp_display_type === 'shortness')) ? persistedGS.dp_display_type : 'shortness';
        // RKCB response structure (1430/3014) - ensure we read from ace_asking.blackwood if present, else slam_bidding.blackwood_rkcb
        const rkcbResp = (cfg?.ace_asking?.blackwood?.responses) || (cfg?.slam_bidding?.blackwood_rkcb?.responses) || '1430';
        const supportThru = (cfg?.competitive?.support_doubles?.thru) || '2S';
        const respDblThru = (cfg?.competitive?.responsive_doubles?.thru_level) || 3;
        const michaelsStrength = (cfg?.competitive?.michaels?.strength) || 'wide_range';
        const unusualOverMinors = !!(cfg?.notrump_defenses?.unusual_nt?.over_minors);
        const sysOn = (cfg?.general?.systems_on_over_1nt_interference) || { transfers: false, stolen_bid_double: false };
        const ntOverMinorsRange = (cfg?.general?.nt_over_minors_range) || 'classic';

        container.innerHTML = `
            <div class="general-settings-card">
                <div class="general-settings-header">General Settings</div>
                <div class="general-settings-row">
                    <label class="toggle">
                        <input type="checkbox" id="toggle_show_all_hands" ${showAllHandsDefault ? 'checked' : ''} />
                        <span>Show all hands by default</span>
                        <span class="general-help-inline">When generating a new deal, start with North/East/West visible.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label for="select_dp_display" class="toggle" style="gap:6px;">
                        <span>Distribution points display</span>
                        <select id="select_dp_display">
                            <option value="shortness" ${dpDisplayType === 'shortness' ? 'selected' : ''}>Shortness (void=3, singleton=2, doubleton=1)</option>
                            <option value="length" ${dpDisplayType === 'length' ? 'selected' : ''}>Length (1 for 5th card, etc.)</option>
                        </select>
                        <span class="general-help-inline">Controls the DP shown next to HCP in the hand panels.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label class="toggle">
                        <input type="checkbox" id="toggle_include_5422" ${include5422 ? 'checked' : ''} />
                        <span>Treat 5-4-2-2 as balanced (semi-balanced)</span>
                        <span class="general-help-inline">Affects 1NT openings and some balanced-hand decisions.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label class="toggle">
                        <input type="checkbox" id="toggle_vul_adjust" ${vulAdj ? 'checked' : ''} />
                        <span>Vulnerability adjustments</span>
                        <span class="general-help-inline">Tightens/loosens aggressive actions (e.g., weak twos) based on vulnerability.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label class="toggle">
                        <input type="checkbox" id="toggle_relaxed_tko" ${relaxedTO ? 'checked' : ''} />
                        <span>Relaxed takeout doubles</span>
                        <span class="general-help-inline">Allows slightly lighter doubles (e.g., 11+ HCP with shape).</span>
                    </label>
                </div>
                
                <div class="general-settings-row" style="margin-top:8px;">
                    <label for="select_support_thru" class="toggle" style="gap:6px;">
                        <span>Support doubles thru</span>
                        <select id="select_support_thru">
                            <option value="2H" ${supportThru === '2H' ? 'selected' : ''}>2♥</option>
                            <option value="2S" ${supportThru === '2S' ? 'selected' : ''}>2♠</option>
                        </select>
                        <span class="general-help-inline">Highest competitive level where support doubles apply.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label for="select_resp_dbl_thru" class="toggle" style="gap:6px;">
                        <span>Responsive doubles thru level</span>
                        <select id="select_resp_dbl_thru">
                            <option value="2" ${Number(respDblThru) === 2 ? 'selected' : ''}>Through 2-level</option>
                            <option value="3" ${Number(respDblThru) === 3 ? 'selected' : ''}>Through 3-level</option>
                        </select>
                        <span class="general-help-inline">Upper bound for using responsive doubles after partner's takeout double.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label for="select_michaels_strength" class="toggle" style="gap:6px;">
                        <span>Michaels strength</span>
                        <select id="select_michaels_strength">
                            <option value="wide_range" ${michaelsStrength === 'wide_range' ? 'selected' : ''}>Wide range</option>
                            <option value="strong_only" ${michaelsStrength === 'strong_only' ? 'selected' : ''}>Strong only</option>
                        </select>
                        <span class="general-help-inline">Wide range allows lighter 6-9 HCP Michaels; strong only uses ~10+ HCP.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label class="toggle">
                        <input type="checkbox" id="toggle_unusual_nt_over_minors" ${unusualOverMinors ? 'checked' : ''} />
                        <span>Unusual 2NT over minors</span>
                        <span class="general-help-inline">2NT over 1♣/1♦ shows the two lowest unbid suits (5-5). When off, 2NT over minors is natural 19–21 with a stopper.</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label for="select_nt_over_minors_range" class="toggle" style="gap:6px;">
                        <span>1NT over 1m (balanced, no 4-card major)</span>
                        <select id="select_nt_over_minors_range">
                            <option value="classic" ${ntOverMinorsRange === 'classic' ? 'selected' : ''}>Classic: 10–11 HCP</option>
                            <option value="wide" ${ntOverMinorsRange === 'wide' ? 'selected' : ''}>Wide: 6–11 HCP</option>
                        </select>
                        <span class="general-help-inline">Choose the invitational floor for 1NT responses over minor openings.</span>
                    </label>
                </div>
                <div class="general-settings-divider" style="margin:10px 0; border-top:1px solid #ddd;"></div>
                <div class="general-settings-header">Systems over 1NT interference</div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label class="toggle">
                        <input type="checkbox" id="toggle_sys_on_transfers" ${sysOn.transfers ? 'checked' : ''} />
                        <span>Keep transfers on over 2♣</span>
                        <span class="general-help-inline">2♦ transfers to ♥ and 2♥ transfers to ♠ after 1NT – (2♣).</span>
                    </label>
                </div>
                <div class="general-settings-row" style="margin-top:8px;">
                    <label class="toggle">
                        <input type="checkbox" id="toggle_sys_on_stolen" ${sysOn.stolen_bid_double ? 'checked' : ''} />
                        <span>Stolen-bid double over 2♣ (X = Stayman)</span>
                        <span class="general-help-inline">When enabled (and Stayman is part of your system), double over 2♣ shows Stayman with 8+ HCP and a 4-card major.</span>
                    </label>
                </div>
                <div class="general-settings-divider" style="margin:10px 0; border-top:1px solid #ddd;"></div>
                <div class="general-settings-row">
                    <div class="general-help-inline" style="font-style:italic; line-height:1.3;">
                        Note: One-level suit jump shifts — Overcalls are weak and natural (6+ in the bid suit, <10 HCP). Responder jump shifts are strong and natural (5+ in the bid suit, 13+ HCP).
                    </div>
                </div>
            </div>
        `;


        const dpSel = document.getElementById('select_dp_display');
        if (dpSel) {
            dpSel.addEventListener('change', (e) => {
                try {
                    // UI-only preference; persist and re-render the hands immediately
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated dp_display_type to', e.target.value);
                    saveGeneralSettings();
                    try { displayHands(); } catch (_) { }
                } catch (err) {
                    console.warn('Failed to update dp_display_type:', err);
                }
            });
        }

        const chk = document.getElementById('toggle_include_5422');
        if (chk) {
            chk.addEventListener('change', (e) => {
                try {
                    if (!system?.conventions?.config?.general) return;
                    if (!system.conventions.config.general.balanced_shapes) {
                        system.conventions.config.general.balanced_shapes = { include_5422: false };
                    }
                    system.conventions.config.general.balanced_shapes.include_5422 = !!e.target.checked;
                    // Optional visual feedback
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated include_5422 to', e.target.checked);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update include_5422:', err);
                }
            });
        }

        const vul = document.getElementById('toggle_vul_adjust');
        if (vul) {
            vul.addEventListener('change', (e) => {
                try {
                    if (!system?.conventions?.config?.general) return;
                    system.conventions.config.general.vulnerability_adjustments = !!e.target.checked;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated vulnerability_adjustments to', e.target.checked);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update vulnerability_adjustments:', err);
                }
            });
        }

        const relaxed = document.getElementById('toggle_relaxed_tko');
        if (relaxed) {
            relaxed.addEventListener('change', (e) => {
                try {
                    if (!system?.conventions?.config?.general) return;
                    system.conventions.config.general.relaxed_takeout_doubles = !!e.target.checked;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated relaxed_takeout_doubles to', e.target.checked);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update relaxed_takeout_doubles:', err);
                }
            });
        }

        // RKCB response selector removed

        const supSel = document.getElementById('select_support_thru');
        if (supSel) {
            supSel.addEventListener('change', (e) => {
                try {
                    const val = e.target.value === '2H' ? '2H' : '2S';
                    if (!system.conventions.config.competitive) system.conventions.config.competitive = {};
                    if (!system.conventions.config.competitive.support_doubles) system.conventions.config.competitive.support_doubles = { enabled: true };
                    system.conventions.config.competitive.support_doubles.thru = val;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated support_doubles.thru to', val);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update support_doubles.thru:', err);
                }
            });
        }

        const respSel = document.getElementById('select_resp_dbl_thru');
        if (respSel) {
            respSel.addEventListener('change', (e) => {
                try {
                    const val = Number(e.target.value) === 2 ? 2 : 3;
                    if (!system.conventions.config.competitive) system.conventions.config.competitive = {};
                    if (!system.conventions.config.competitive.responsive_doubles) system.conventions.config.competitive.responsive_doubles = { enabled: true };
                    system.conventions.config.competitive.responsive_doubles.thru_level = val;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated responsive_doubles.thru_level to', val);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update responsive_doubles.thru_level:', err);
                }
            });
        }

        const micSel = document.getElementById('select_michaels_strength');
        if (micSel) {
            micSel.addEventListener('change', (e) => {
                try {
                    const val = e.target.value === 'strong_only' ? 'strong_only' : 'wide_range';
                    if (!system.conventions.config.competitive) system.conventions.config.competitive = {};
                    if (!system.conventions.config.competitive.michaels) system.conventions.config.competitive.michaels = { enabled: true };
                    system.conventions.config.competitive.michaels.strength = val;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated michaels.strength to', val);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update michaels.strength:', err);
                }
            });
        }

        const unnOverMin = document.getElementById('toggle_unusual_nt_over_minors');
        if (unnOverMin) {
            unnOverMin.addEventListener('change', (e) => {
                try {
                    if (!system?.conventions?.config) return;
                    const cfg = system.conventions.config;
                    cfg.notrump_defenses = cfg.notrump_defenses || {};
                    cfg.notrump_defenses.unusual_nt = cfg.notrump_defenses.unusual_nt || { enabled: true, direct: true, passed_hand: false, over_minors: false };
                    cfg.notrump_defenses.unusual_nt.over_minors = !!e.target.checked;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated unusual_nt.over_minors to', e.target.checked);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update unusual_nt.over_minors:', err);
                }
            });
        }

        const ntRangeSel = document.getElementById('select_nt_over_minors_range');
        if (ntRangeSel) {
            ntRangeSel.addEventListener('change', (e) => {
                try {
                    const val = (e.target.value === 'wide') ? 'wide' : 'classic';
                    if (!system?.conventions?.config?.general) return;
                    system.conventions.config.general.nt_over_minors_range = val;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated general.nt_over_minors_range to', val);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update nt_over_minors_range:', err);
                }
            });
        }

        const showAllChk = document.getElementById('toggle_show_all_hands');
        if (showAllChk) {
            showAllChk.addEventListener('change', () => {
                try {
                    // UI-only preference; just persist
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated show_all_hands_by_default to', showAllChk.checked);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update show_all_hands_by_default:', err);
                }
            });
        }

        const sysTrans = document.getElementById('toggle_sys_on_transfers');
        if (sysTrans) {
            sysTrans.addEventListener('change', (e) => {
                try {
                    if (!system?.conventions?.config?.general) return;
                    const g = system.conventions.config.general;
                    g.systems_on_over_1nt_interference = g.systems_on_over_1nt_interference || { transfers: false, stolen_bid_double: false };
                    g.systems_on_over_1nt_interference.transfers = !!e.target.checked;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated systems_on_over_1nt_interference.transfers to', e.target.checked);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update systems_on_over_1nt_interference.transfers:', err);
                }
            });
        }

        const sysStolen = document.getElementById('toggle_sys_on_stolen');
        if (sysStolen) {
            sysStolen.addEventListener('change', (e) => {
                try {
                    if (!system?.conventions?.config?.general) return;
                    const g = system.conventions.config.general;
                    g.systems_on_over_1nt_interference = g.systems_on_over_1nt_interference || { transfers: false, stolen_bid_double: false };
                    g.systems_on_over_1nt_interference.stolen_bid_double = !!e.target.checked;
                    container.classList.add('flash-updated');
                    setTimeout(() => container.classList.remove('flash-updated'), 600);
                    pageLog('Updated systems_on_over_1nt_interference.stolen_bid_double to', e.target.checked);
                    saveGeneralSettings();
                } catch (err) {
                    console.warn('Failed to update systems_on_over_1nt_interference.stolen_bid_double:', err);
                }
            });
        }
    } catch (e) {
        console.warn('createGeneralSettingsSection failed:', e);
    }
}

function updateMutualExclusivityForRKCB(rkcbLabel) {
    if (!Array.isArray(mutuallyExclusiveGroups)) return;
    for (let i = 0; i < mutuallyExclusiveGroups.length; i++) {
        const group = mutuallyExclusiveGroups[i];
        if (Array.isArray(group) && group.includes('Regular Blackwood')) {
            // Replace the RKCB entry in that group with the current label
            const otherIdx = group[0] === 'Regular Blackwood' ? 1 : 0;
            group[otherIdx] = rkcbLabel;
            mutuallyExclusiveGroups[i] = ['Regular Blackwood', rkcbLabel];
            break;
        }
    }
}

// Add a transient highlight to the RKCB convention item(s) after label update
function flashRKCBLabel(rkcbLabel) {
    const idBase = rkcbLabel.replace(/\s+/g, '_');
    const targetIds = [
        `conv_${idBase}`,
        `practice_${idBase}`
    ];
    targetIds.forEach(id => {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (!lbl || !lbl.parentElement) return;
        const container = lbl.parentElement;
        if (!container.classList || !container.classList.contains('convention-item')) return;
        // Retrigger animation reliably
        container.classList.remove('rkcb-flash');
        // Force reflow
        void container.offsetWidth;
        container.classList.add('rkcb-flash');
        container.addEventListener('animationend', () => {
            container.classList.remove('rkcb-flash');
        }, { once: true });
    });
}

async function loadAvailableConventions() {
    try {
        // Use the config already loaded by ConventionCard to avoid any fetch/CORS
        let conventionsConfig = system?.conventions?.config || null;
        if (!conventionsConfig) {
            // Fallback to hardcoded defaults when config isn't available yet
            loadFallbackConventions();
            return;
        }

        // Parse conventions from the loaded configuration
        availableConventions = {};
        conventionCategories = {};
        mutuallyExclusiveGroups = [];

        // Process each category
        Object.keys(conventionsConfig).forEach(categoryKey => {
            const category = conventionsConfig[categoryKey];

            // Skip general category for UI display but still process for background use
            if (categoryKey !== 'general') {
                conventionCategories[categoryKey] = {
                    name: getCategoryDisplayName(categoryKey),
                    conventions: []
                };
            }

            // Process conventions in this category
            Object.keys(category).forEach(conventionKey => {
                const convention = category[conventionKey];
                // Hide advancer_raises from the UI while keeping it in engine config
                if (categoryKey === 'competitive' && conventionKey === 'advancer_raises') {
                    return;
                }
                // Skip items we will synthesize into other UI categories to avoid dupes
                if (categoryKey === 'ace_asking' && conventionKey === 'blackwood') {
                    return; // synthesized under slam_bidding below
                }
                if (categoryKey === 'preempts' && conventionKey === 'weak_two') {
                    return; // synthesized under opening_bids below
                }

                const displayName = getConventionDisplayName(conventionKey);
                // UI should list Unusual NT under Competitive even if engine stores it under notrump_defenses
                const uiCategory = (conventionKey === 'unusual_nt') ? 'competitive' : categoryKey;

                // Ensure UI category bucket exists when remapping
                if (uiCategory !== 'general' && !conventionCategories[uiCategory]) {
                    conventionCategories[uiCategory] = {
                        name: getCategoryDisplayName(uiCategory),
                        conventions: []
                    };
                }

                availableConventions[displayName] = {
                    category: uiCategory,
                    key: conventionKey,
                    description: convention.description || getDefaultDescription(conventionKey),
                    enabled: convention.enabled !== false, // Default to enabled unless explicitly disabled
                    isGeneral: categoryKey === 'general' // Mark general conventions
                };

                // Only add to UI categories if not general
                if (uiCategory !== 'general') {
                    conventionCategories[uiCategory].conventions.push(displayName);
                }
            });
        });

        // Synthesize Opening Bids category with Strong 2C and Weak Two (from config.preempts)
        try {
            if (!conventionCategories['opening_bids']) {
                conventionCategories['opening_bids'] = { name: getCategoryDisplayName('opening_bids'), conventions: [] };
            }
            // Strong 2 Clubs (always available; UI toggle only)
            if (!availableConventions['Strong 2 Clubs']) {
                availableConventions['Strong 2 Clubs'] = {
                    category: 'opening_bids',
                    key: 'strong_2_clubs',
                    description: getDefaultDescription('strong_2_clubs'),
                    enabled: true,
                    isGeneral: false
                };
            }
            if (!conventionCategories['opening_bids'].conventions.includes('Strong 2 Clubs')) {
                conventionCategories['opening_bids'].conventions.push('Strong 2 Clubs');
            }
            // Weak 2 Bids (reflect engine config if present)
            const weakTwoEnabled = !!(conventionsConfig?.preempts?.weak_two?.enabled);
            if (!availableConventions['Weak 2 Bids']) {
                availableConventions['Weak 2 Bids'] = {
                    category: 'opening_bids',
                    key: 'weak_2_bids',
                    description: getDefaultDescription('weak_2_bids'),
                    enabled: weakTwoEnabled,
                    isGeneral: false
                };
            } else {
                // Ensure enabled reflects config
                availableConventions['Weak 2 Bids'].enabled = weakTwoEnabled;
                availableConventions['Weak 2 Bids'].category = 'opening_bids';
            }
            if (!conventionCategories['opening_bids'].conventions.includes('Weak 2 Bids')) {
                conventionCategories['opening_bids'].conventions.push('Weak 2 Bids');
            }
        } catch (e) {
            console.warn('Failed to synthesize Opening Bids category:', e);
        }

        // Synthesize Slam Bidding category from ace_asking config (Gerber + Blackwood variants)
        try {
            const ace = conventionsConfig?.ace_asking || {};
            const blackwood = ace.blackwood || { enabled: true, variant: 'rkcb', responses: '1430' };
            const rkcbResp = (blackwood.responses === '3014') ? '3014' : '1430';
            const rkcbLabel = `RKC Blackwood ${rkcbResp}`;
            if (!conventionCategories['slam_bidding']) {
                conventionCategories['slam_bidding'] = { name: getCategoryDisplayName('slam_bidding'), conventions: [] };
            }
            // Gerber
            const gerberEnabled = !!(ace?.gerber?.enabled !== false);
            if (!availableConventions['Gerber']) {
                availableConventions['Gerber'] = {
                    category: 'slam_bidding',
                    key: 'gerber',
                    description: getDefaultDescription('gerber'),
                    enabled: gerberEnabled,
                    isGeneral: false
                };
            } else {
                availableConventions['Gerber'].category = 'slam_bidding';
                availableConventions['Gerber'].enabled = gerberEnabled;
            }
            if (!conventionCategories['slam_bidding'].conventions.includes('Gerber')) {
                conventionCategories['slam_bidding'].conventions.push('Gerber');
            }
            // Regular Blackwood (enabled when variant is NOT rkcb)
            const isRkcb = (blackwood.variant === 'rkcb');
            if (!availableConventions['Regular Blackwood']) {
                availableConventions['Regular Blackwood'] = {
                    category: 'slam_bidding',
                    key: 'blackwood_regular',
                    description: getDefaultDescription('blackwood_regular'),
                    enabled: !isRkcb,
                    isGeneral: false
                };
            } else {
                availableConventions['Regular Blackwood'].category = 'slam_bidding';
                availableConventions['Regular Blackwood'].enabled = !isRkcb;
            }
            if (!conventionCategories['slam_bidding'].conventions.includes('Regular Blackwood')) {
                conventionCategories['slam_bidding'].conventions.push('Regular Blackwood');
            }
            // RKCB Blackwood (enabled when variant is rkcb)
            if (!availableConventions[rkcbLabel]) {
                availableConventions[rkcbLabel] = {
                    category: 'slam_bidding',
                    key: 'blackwood_rkcb',
                    description: getDefaultDescription('blackwood_rkcb'),
                    enabled: isRkcb,
                    isGeneral: false
                };
            } else {
                availableConventions[rkcbLabel].category = 'slam_bidding';
                availableConventions[rkcbLabel].enabled = isRkcb;
            }
            if (!conventionCategories['slam_bidding'].conventions.includes(rkcbLabel)) {
                conventionCategories['slam_bidding'].conventions.push(rkcbLabel);
            }
            // Remove legacy ace_asking category from UI if present
            if (conventionCategories['ace_asking']) {
                delete conventionCategories['ace_asking'];
            }
        } catch (e) {
            console.warn('Failed to synthesize Slam Bidding category:', e);
        }

        // Move Meckwell from strong_club_defenses to No Trump Defenses for UI consistency
        try {
            if (conventionCategories['strong_club_defenses']) {
                const meckLabel = 'Meckwell';
                if (!conventionCategories['notrump_defenses']) {
                    conventionCategories['notrump_defenses'] = { name: getCategoryDisplayName('notrump_defenses'), conventions: [] };
                }
                if (availableConventions[meckLabel]) {
                    availableConventions[meckLabel].category = 'notrump_defenses';
                    if (!conventionCategories['notrump_defenses'].conventions.includes(meckLabel)) {
                        conventionCategories['notrump_defenses'].conventions.push(meckLabel);
                    }
                }
                // Remove from original category list if present
                const idx = conventionCategories['strong_club_defenses'].conventions.indexOf(meckLabel);
                if (idx >= 0) conventionCategories['strong_club_defenses'].conventions.splice(idx, 1);
                // If empty, drop the category
                if (conventionCategories['strong_club_defenses'].conventions.length === 0) {
                    delete conventionCategories['strong_club_defenses'];
                }
            }
        } catch (e) {
            console.warn('Failed to relocate Meckwell to notrump_defenses:', e);
        }

        // Ensure Unusual NT always appears under Competitive Bidding in the UI
        try {
            const unnName = getConventionDisplayName('unusual_nt');
            const unnCfg = conventionsConfig?.competitive?.unusual_nt || conventionsConfig?.notrump_defenses?.unusual_nt;
            const unnEnabled = !(unnCfg?.enabled === false);
            const unnDesc = unnCfg?.description || getDefaultDescription('unusual_nt');

            if (!conventionCategories['competitive']) {
                conventionCategories['competitive'] = { name: getCategoryDisplayName('competitive'), conventions: [] };
            }

            // Create or normalize the convention entry
            if (!availableConventions[unnName]) {
                availableConventions[unnName] = {
                    category: 'competitive',
                    key: 'unusual_nt',
                    description: unnDesc,
                    enabled: unnEnabled,
                    isGeneral: false
                };
            } else {
                availableConventions[unnName].category = 'competitive';
                availableConventions[unnName].enabled = unnEnabled;
                availableConventions[unnName].description = availableConventions[unnName].description || unnDesc;
            }

            if (!conventionCategories['competitive'].conventions.includes(unnName)) {
                conventionCategories['competitive'].conventions.push(unnName);
            }

            // Keep Unusual NT listed immediately after Michaels in the UI
            const competitiveList = conventionCategories['competitive'].conventions;
            const reordered = [];
            const pushIfPresent = (name) => {
                const idx = competitiveList.indexOf(name);
                if (idx >= 0) reordered.push(name);
            };
            pushIfPresent('Michaels');
            pushIfPresent(unnName);
            competitiveList
                .filter(name => !reordered.includes(name))
                .forEach(name => reordered.push(name));
            conventionCategories['competitive'].conventions = reordered;
        } catch (e) {
            console.warn('Failed to ensure Unusual NT appears under Competitive:', e);
        }

        // Set up mutual exclusivity groups
        mutuallyExclusiveGroups = [
            ['DONT', 'Meckwell'], // NT defense systems are mutually exclusive
            ['Regular Blackwood', 'RKC Blackwood 1430'] // Blackwood variants are mutually exclusive
        ];

        // Initialize enabled conventions based on JSON configuration
        enabledConventions = {};
        Object.keys(availableConventions).forEach(name => {
            const convention = availableConventions[name];
            // General conventions are always enabled
            if (convention.isGeneral) {
                enabledConventions[name] = true;
            } else {
                enabledConventions[name] = convention.enabled;
            }
        });

        pageLog('Conventions loaded from inline/default config:', Object.keys(availableConventions));

        // Reorder categories for a balanced two-column layout, with Slam Bidding below Responses (first column)
        const desiredOrder = ['opening_bids', 'notrump_responses', 'responses', 'competitive', 'slam_bidding', 'notrump_defenses'];
        const orderedCategories = {};
        desiredOrder.forEach(key => {
            if (conventionCategories[key]) {
                orderedCategories[key] = conventionCategories[key];
            }
        });
        // Append any categories not explicitly ordered
        Object.keys(conventionCategories).forEach(key => {
            if (!orderedCategories[key]) {
                orderedCategories[key] = conventionCategories[key];
            }
        });
        conventionCategories = orderedCategories;

    } catch (error) {
        console.error('Error loading conventions (using fallback):', error);
        // Fallback to hardcoded conventions
        loadFallbackConventions();
    }
}

function getCategoryDisplayName(categoryKey) {
    const categoryNames = {
        'opening_bids': 'Opening Bids',
        'slam_bidding': 'Slam Bidding',
        'ace_asking': 'Ace Asking', // Legacy support
        'notrump_responses': 'No Trump Responses',
        'notrump_defenses': 'No Trump Defenses',
        'responses': 'Responses',
        'competitive': 'Competitive Bidding',
        'general': 'General Conventions'
    };
    return categoryNames[categoryKey] || categoryKey;
}

function getConventionDisplayName(conventionKey) {
    // Always show RKCB as 1430 in the Active Conventions list
    if (conventionKey === 'blackwood_rkcb') {
        return 'RKC Blackwood 1430';
    }
    const conventionNames = {
        'strong_2_clubs': 'Strong 2 Clubs',
        'weak_2_bids': 'Weak 2 Bids',
        'stayman': 'Stayman',
        'jacoby_transfers': 'Jacoby Transfers',
        'texas_transfers': 'Texas Transfers',
        'minor_suit_transfers': 'Minor Suit Transfers',
        'control_showing_cue_bids': 'Control Showing Cue Bids',
        'gerber': 'Gerber',
        'blackwood_regular': 'Regular Blackwood',
        'blackwood_rkcb': 'RKC Blackwood 1430',
        'dont': 'DONT',
        'meckwell': 'Meckwell',
        'lebensohl': 'Lebensohl',
        'jacoby_2nt': 'Jacoby 2NT',
        'splinter_bids': 'Splinter Bids',
        'unusual_nt': 'Unusual NT',
        'michaels': 'Michaels',
        'responsive_doubles': 'Responsive Doubles',
        'negative_doubles': 'Negative Doubles',
        'takeout_doubles': 'Takeout Doubles',
        'support_doubles': 'Support Doubles',
        'reopening_doubles': 'Reopening Doubles',
        'cue_bid_raises': 'Cue Bid Raises',
        'drury': 'Drury',
        'bergen_raises': 'Bergen Raises'

    };
    return conventionNames[conventionKey] || conventionKey;
}

function getDefaultDescription(conventionKey) {
    const descriptions = {
        'strong_2_clubs': '2C opening shows 22+ HCP, artificial and game forcing',
        'weak_2_bids': 'Weak 2 bids in diamonds, hearts, and spades',
        'stayman': '2C asking for a 4-card major over partner\'s 1NT',
        'jacoby_transfers': '2D/2H over 1NT (3D/3H over 2NT) transferring to hearts/spades',
        'texas_transfers': '4D/4H over 1NT/2NT transferring to 4H/4S to play',
        'minor_suit_transfers': '2S transfers to clubs; 2NT transfers to diamonds over 1NT',
        'control_showing_cue_bids': 'Cue bids showing first or second round control in slam-going auctions',
        'gerber': 'Ace asking convention using 4C',
        'blackwood_regular': 'Regular Blackwood asking for aces only',
        'blackwood_rkcb': 'Roman Key Card Blackwood (1430 responses)',
        'dont': 'Defense against 1NT opening',
        'meckwell': 'Defense against strong club systems',
        'lebensohl': 'Lebensohl convention after interference',
        'jacoby_2nt': 'Game forcing raise of major suit',
        'splinter_bids': 'Jump bids showing shortness and support',
        'unusual_nt': 'Unusual No Trump showing minors',
        'michaels': 'Cue bid showing 5-5 in majors or major+minor',
        'responsive_doubles': 'Doubles after partner\'s takeout double',
        'negative_doubles': 'Doubles showing unbid major(s)',
        'takeout_doubles': 'Double for takeout, asking partner to bid',
        'support_doubles': 'Double showing 3-card support for partner\'s suit',
        'reopening_doubles': 'Doubles in reopening position',
        'cue_bid_raises': 'Cue bids showing strong raises after interference',
        'bergen_raises': '3♣ = 7-10 HCP and 4+ trumps; 3♦ = 11-12 HCP and 4+ trumps; 3M = preemptive (0-6 HCP, 4+ trumps)'

    };
    return descriptions[conventionKey] || 'Bridge convention';
}

function loadFallbackConventions() {
    // Fallback hardcoded conventions if JSON loading fails
    const rkcbName = 'RKC Blackwood 1430';
    availableConventions = {
        'Strong 2 Clubs': { category: 'opening_bids', key: 'strong_2_clubs', description: '2C opening shows 22+ HCP, artificial and game forcing', enabled: true, isGeneral: false },
        'Weak 2 Bids': { category: 'opening_bids', key: 'weak_2_bids', description: 'Weak 2 bids in diamonds, hearts, and spades', enabled: true, isGeneral: false },
        'Stayman': { category: 'notrump_responses', key: 'stayman', description: '2C asking for a 4-card major over partner\'s 1NT', enabled: true, isGeneral: false },
        'Jacoby Transfers': { category: 'notrump_responses', key: 'jacoby_transfers', description: '2D/2H over 1NT; 3D/3H over 2NT transfer to H/S', enabled: true, isGeneral: false },
        'Texas Transfers': { category: 'notrump_responses', key: 'texas_transfers', description: '4D/4H over 1NT/2NT transfer to 4H/4S', enabled: true, isGeneral: false },
        'Minor Suit Transfers': { category: 'notrump_responses', key: 'minor_suit_transfers', description: '2S->3C; 2NT->3D over 1NT', enabled: false, isGeneral: false },
        'Gerber': { category: 'slam_bidding', key: 'gerber', description: 'Ace asking convention using 4C', enabled: true, isGeneral: false },
        'Regular Blackwood': { category: 'slam_bidding', key: 'blackwood_regular', description: 'Regular Blackwood asking for aces only', enabled: false, isGeneral: false },
        [rkcbName]: { category: 'slam_bidding', key: 'blackwood_rkcb', description: 'Roman Key Card Blackwood (1430 responses)', enabled: true, isGeneral: false },
        'Control Showing Cue Bids': { category: 'slam_bidding', key: 'control_showing_cue_bids', description: 'Cue bids showing first or second round control in slam-going auctions', enabled: true, isGeneral: false },
        'DONT': { category: 'notrump_defenses', key: 'dont', description: 'Defense against 1NT opening', enabled: true, isGeneral: false },
        'Meckwell': { category: 'notrump_defenses', key: 'meckwell', description: 'Defense against strong club systems', enabled: false, isGeneral: false },
        'Jacoby 2NT': { category: 'responses', key: 'jacoby_2nt', description: 'Game forcing raise of major suit', enabled: true, isGeneral: false },
        'Splinter Bids': { category: 'responses', key: 'splinter_bids', description: 'Jump bids showing shortness and support', enabled: true, isGeneral: false },
        'Bergen Raises': { category: 'responses', key: 'bergen_raises', description: '3♣/3♦ raises with 4+ trumps (7-10, 11-12); 3M preemptive 0-6', enabled: false, isGeneral: false },
        'Lebensohl': { category: 'competitive', key: 'lebensohl', description: 'Lebensohl convention after interference', enabled: true, isGeneral: false },
        'Unusual NT': { category: 'competitive', key: 'unusual_nt', description: 'Unusual No Trump showing minors', enabled: true, isGeneral: false },
        'Michaels': { category: 'competitive', key: 'michaels', description: 'Cue bid showing 5-5 in majors or major+minor', enabled: true, isGeneral: false },
        'Responsive Doubles': { category: 'competitive', key: 'responsive_doubles', description: 'Doubles after partner\'s takeout double', enabled: true, isGeneral: false },
        'Negative Doubles': { category: 'competitive', key: 'negative_doubles', description: 'Doubles showing unbid major(s)', enabled: true, isGeneral: false },
        'Takeout Doubles': { category: 'competitive', key: 'takeout_doubles', description: 'Double for takeout, asking partner to bid', enabled: true, isGeneral: false },
        'Support Doubles': { category: 'competitive', key: 'support_doubles', description: 'Double showing 3-card support for partner\'s suit', enabled: true, isGeneral: false },
        'Reopening Doubles': { category: 'competitive', key: 'reopening_doubles', description: 'Doubles in reopening position', enabled: true, isGeneral: false },
        'Cue Bid Raises': { category: 'competitive', key: 'cue_bid_raises', description: 'Cue bids showing strong raises after interference', enabled: true, isGeneral: false },
        'Drury': { category: 'responses', key: 'drury', description: 'Drury convention for passed hand major suit raises', enabled: true, isGeneral: false },

        'Vulnerability Adjustments': { category: 'general', key: 'vulnerability_adjustments', description: 'Adjust bidding based on vulnerability', enabled: true, isGeneral: true },
        'Passed Hand Variations': { category: 'general', key: 'passed_hand_variations', description: 'Variations for passed hand bidding', enabled: true, isGeneral: true },
        'Balance of Power': { category: 'general', key: 'balance_of_power', description: 'Balance of power considerations', enabled: true, isGeneral: true }
    };

    conventionCategories = {
        'opening_bids': { name: 'Opening Bids', conventions: ['Strong 2 Clubs', 'Weak 2 Bids'] },
        'notrump_responses': { name: 'No Trump Responses', conventions: ['Stayman', 'Jacoby Transfers', 'Texas Transfers', 'Minor Suit Transfers'] },
        'responses': { name: 'Responses', conventions: ['Jacoby 2NT', 'Splinter Bids', 'Bergen Raises', 'Drury'] },
        'competitive': { name: 'Competitive Bidding', conventions: ['Lebensohl', 'Unusual NT', 'Michaels', 'Responsive Doubles', 'Negative Doubles', 'Takeout Doubles', 'Support Doubles', 'Reopening Doubles', 'Cue Bid Raises'] },
        'slam_bidding': { name: 'Slam Bidding', conventions: ['Gerber', 'Regular Blackwood', rkcbName, 'Control Showing Cue Bids'] },
        'notrump_defenses': { name: 'No Trump Defenses', conventions: ['DONT', 'Meckwell'] }
    };

    mutuallyExclusiveGroups = [
        ['DONT', 'Meckwell'],
        ['Regular Blackwood', rkcbName]
    ];

    enabledConventions = {};
    Object.keys(availableConventions).forEach(name => {
        const convention = availableConventions[name];
        // General conventions are always enabled
        if (convention.isGeneral) {
            enabledConventions[name] = true;
        } else {
            enabledConventions[name] = convention.enabled;
        }
    });
}

function createConventionCheckboxes() {
    pageLog('createConventionCheckboxes called');
    pageLog('conventionCategories:', conventionCategories);
    pageLog('availableConventions:', availableConventions);

    const container = document.getElementById('conventionCheckboxes');
    if (!container) {
        console.error('conventionCheckboxes container not found');
        return;
    }

    container.innerHTML = '';

    // Build two independent columns so left stack isn't constrained by right column height
    const col1 = document.createElement('div');
    const col2 = document.createElement('div');
    const col3 = document.createElement('div');
    col1.className = 'convention-col col1';
    col2.className = 'convention-col col2';
    col3.className = 'convention-col col3';

    // Three-column layout per request:
    // 1) Opening Bids, Competitive Bidding
    // 2) No Trump Responses, No Trump Defenses
    // 3) Responses, Slam Bidding
    const col1Order = ['opening_bids', 'competitive'];
    const col2Order = ['notrump_responses', 'notrump_defenses'];
    const col3Order = ['responses', 'slam_bidding'];

    const renderCategory = (categoryKey, targetCol) => {
        const category = conventionCategories[categoryKey];
        if (!category) return;

        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'convention-category';

        const categoryHeader = document.createElement('h6');
        categoryHeader.className = 'convention-category-header';
        categoryHeader.textContent = category.name;
        categoryDiv.appendChild(categoryHeader);

        const rowDiv = document.createElement('div');
        rowDiv.className = 'convention-row';

        category.conventions.forEach(conventionName => {
            const convention = availableConventions[conventionName];
            if (!convention) return;
            // Skip practice-only pseudo items from Active Conventions UI
            if (convention.practiceOnly) return;

            const itemDiv = document.createElement('div');
            itemDiv.className = 'convention-item';
            itemDiv.title = convention.description;

            itemDiv.innerHTML = `
                <input type="checkbox" id="conv_${conventionName.replace(/\s+/g, '_')}" 
                       ${enabledConventions[conventionName] ? 'checked' : ''} 
                       onchange="updateConventionStatus('${conventionName}', this.checked)">
                <label for="conv_${conventionName.replace(/\s+/g, '_')}">
                    ${conventionName}
                </label>
            `;

            rowDiv.appendChild(itemDiv);
        });

        categoryDiv.appendChild(rowDiv);
        targetCol.appendChild(categoryDiv);
    };

    col1Order.forEach(key => renderCategory(key, col1));
    col2Order.forEach(key => renderCategory(key, col2));
    col3Order.forEach(key => renderCategory(key, col3));

    // Append columns to container (container itself is a 2-col grid via CSS)
    container.appendChild(col1);
    container.appendChild(col2);
    container.appendChild(col3);
}

function createPracticeConventionOptions() {
    const container = document.getElementById('practiceConventionCheckboxes');
    if (!container) return;

    container.innerHTML = '';

    // Two independent columns for practice options
    const col1 = document.createElement('div');
    const col2 = document.createElement('div');
    const col3 = document.createElement('div');
    col1.className = 'convention-col col1';
    col2.className = 'convention-col col2';
    col3.className = 'convention-col col3';

    // Mirror Active tab three-column grouping
    // 1) Opening Bids, Competitive Bidding
    // 2) No Trump Responses, No Trump Defenses
    // 3) Responses, Slam Bidding
    const col1Order = ['opening_bids', 'competitive'];
    const col2Order = ['notrump_responses', 'notrump_defenses'];
    const col3Order = ['responses', 'slam_bidding'];

    const renderPracticeCategory = (categoryKey, targetCol) => {
        const category = conventionCategories[categoryKey];
        if (!category) return;

        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'convention-category';

        const categoryHeader = document.createElement('h6');
        categoryHeader.className = 'convention-category-header';
        categoryHeader.textContent = category.name;
        categoryDiv.appendChild(categoryHeader);

        const rowDiv = document.createElement('div');
        rowDiv.className = 'convention-row';

        category.conventions.forEach(conventionName => {
            const convention = availableConventions[conventionName];
            if (!convention) return;

            const itemDiv = document.createElement('div');
            itemDiv.className = 'convention-item';
            itemDiv.title = convention.description;

            // For practice-only items, enablement depends on current engine config (not an Active checkbox)
            let isActiveEnabled = enabledConventions[conventionName];
            if (convention.practiceOnly) {
                try {
                    const unn = system?.conventions?.config?.notrump_defenses?.unusual_nt;
                    isActiveEnabled = !!(unn && unn.enabled !== false && unn.over_minors === true);
                } catch (_) { isActiveEnabled = false; }
            }
            const isChecked = selectedPracticeConventions[categoryKey] === conventionName && isActiveEnabled;

            if (!isActiveEnabled) {
                itemDiv.style.opacity = '0.6';
                itemDiv.style.cursor = 'not-allowed';
            }

            // Build label + optional tooltip for practice-only entries
            const isUnusualOverMinors = !!(convention.practiceOnly && convention.key === 'unusual_nt_over_minors');
            const tipText = isUnusualOverMinors
                ? 'Unusual 2NT over minors:\nOver 1♣ → shows ♦ + ♥ (5-5).\nOver 1♦ → shows ♣ + ♥ (5-5).'
                : '';
            itemDiv.innerHTML = `
                <input type="radio" name="practice_${categoryKey}" id="practice_${conventionName.replace(/\s+/g, '_')}" 
                       ${isChecked ? 'checked' : ''} 
                       ${!isActiveEnabled ? 'disabled' : ''}
                       onchange="updatePracticeConventionSelection('${categoryKey}', '${conventionName}')">
                <label for="practice_${conventionName.replace(/\s+/g, '_')}" ${!isActiveEnabled ? 'style=\"color: #6c757d;\"' : ''}>
                    ${conventionName}
                </label>
                ${isUnusualOverMinors ? `<span class="practice-help" title="${tipText}" aria-label="${tipText}" style="margin-left:6px; cursor:help; user-select:none;">ⓘ</span>` : ''}
            `;

            rowDiv.appendChild(itemDiv);
        });

        categoryDiv.appendChild(rowDiv);
        targetCol.appendChild(categoryDiv);
    };

    col1Order.forEach(key => renderPracticeCategory(key, col1));
    col2Order.forEach(key => renderPracticeCategory(key, col2));
    col3Order.forEach(key => renderPracticeCategory(key, col3));

    container.appendChild(col1);
    container.appendChild(col2);
    container.appendChild(col3);
}

function updateConventionStatus(conventionName, enabled) {
    // Handle mutual exclusivity
    if (enabled) {
        // Check if this convention is mutually exclusive with others
        mutuallyExclusiveGroups.forEach(group => {
            if (group.includes(conventionName)) {
                // Disable other conventions in this group
                group.forEach(otherConvention => {
                    if (otherConvention !== conventionName && enabledConventions[otherConvention]) {
                        enabledConventions[otherConvention] = false;
                        // Update the checkbox
                        const otherCheckbox = document.getElementById(`conv_${otherConvention.replace(/\s+/g, '_')}`);
                        if (otherCheckbox) {
                            otherCheckbox.checked = false;
                        }
                        // Remove from practice conventions
                        if (practiceConventions.includes(otherConvention)) {
                            practiceConventions = practiceConventions.filter(name => name !== otherConvention);
                        }
                        pageLog(`Convention ${otherConvention} auto-disabled due to mutual exclusivity with ${conventionName}`);
                    }
                });
            }
        });
    }

    enabledConventions[conventionName] = enabled;

    // If disabling a convention, also remove it from practice conventions
    if (!enabled && practiceConventions.includes(conventionName)) {
        practiceConventions = practiceConventions.filter(name => name !== conventionName);
    }

    // Refresh practice convention checkboxes to reflect changes
    createPracticeConventionOptions();
    // Push changes down to engine configuration so bidding logic respects the UI
    try { updateSystemConventions(); } catch (e) { console.warn('Failed to sync convention change to engine:', e); }

    try { saveEnabledConventions(); } catch (_) { }
    pageLog(`Convention ${conventionName} ${enabled ? 'enabled' : 'disabled'}`);
}

function updatePracticeConvention(conventionName, enabled) {
    if (enabled) {
        if (!practiceConventions.includes(conventionName)) {
            practiceConventions.push(conventionName);
        }
    } else {
        practiceConventions = practiceConventions.filter(name => name !== conventionName);
    }

    pageLog(`Practice convention ${conventionName} ${enabled ? 'enabled' : 'disabled'}`);
}

function updatePracticeConventionSelection(categoryKey, conventionName) {
    // Update the selected convention for this category
    if (conventionName === null) {
        delete selectedPracticeConventions[categoryKey];
    } else {
        selectedPracticeConventions[categoryKey] = conventionName;
    }

    pageLog(`Practice convention selection for ${categoryKey}: ${conventionName || 'None'}`);
    pageLog('Current practice selections:', selectedPracticeConventions);
}

// Normalize common aliases so practice selections and validation stay aligned
function normalizeConventionLabel(name) {
    if (!name) return name;
    const trimmed = String(name).trim();
    const aliases = {
        'Strong 2C': 'Strong 2 Clubs',
        'Strong 2 Club': 'Strong 2 Clubs'
    };
    return aliases[trimmed] || trimmed;
}

function getSelectedPracticeTargets() {
    try {
        const values = Object.values(selectedPracticeConventions || {})
            .filter(Boolean)
            .map(normalizeConventionLabel);
        const unique = Array.from(new Set(values));

        // If a practice target is selected but currently disabled, turn it on so generation and
        // explanations can reflect the chosen convention without requiring a separate enable step.
        unique.forEach(name => {
            if (!enabledConventions[name]) {
                enabledConventions[name] = true;
            }
        });

        try { updateSystemConventions(); } catch (_) { /* best-effort sync */ }
        return unique;
    } catch (_) {
        return [];
    }
}

function clearPracticeSelections() {
    selectedPracticeConventions = {};
    try { createPracticeConventionOptions(); } catch (_) { /* no-op */ }
    pageLog('Practice convention selections cleared');
}

// Inline onchange handlers in the Active/Practice Conventions UI need these in global scope
try {
    if (typeof window !== 'undefined') {
        window.updateConventionStatus = updateConventionStatus;
        window.updatePracticeConventionSelection = updatePracticeConventionSelection;
        window.clearPracticeSelections = clearPracticeSelections;
    }
} catch (_) { /* no-op */ }

function updateSystemConventions() {
    // Update the system's convention configuration based on enabled conventions
    if (!system || !system.conventions || !system.conventions.config) return;

    const config = system.conventions.config;

    // Update each convention category (generic path)
    Object.keys(availableConventions).forEach(conventionName => {
        const convention = availableConventions[conventionName];
        const enabled = !!enabledConventions[conventionName];

        try {
            // Create category/key path if it's missing (future-proof for new conventions)
            if (convention.category && !config[convention.category]) {
                config[convention.category] = {};
            }

            if (convention.category && convention.key) {
                const currentVal = config[convention.category][convention.key];
                if (typeof currentVal === 'boolean') {
                    config[convention.category][convention.key] = enabled;
                } else if (typeof currentVal === 'string') {
                    // String settings (e.g. 'classic') are not toggles; ignore
                } else {
                    // Object or undefined
                    if (!currentVal) {
                        config[convention.category][convention.key] = { enabled: enabled };
                    } else {
                        config[convention.category][convention.key].enabled = enabled;
                    }
                }
            }
        } catch (error) {
            console.warn(`Could not update convention ${conventionName}:`, error);
        }

        // Special-case mappings to underlying engine config (category/key mismatches or complex variants)
        try {
            // Weak 2 Bids UI -> preempts.weak_two
            if (convention.key === 'weak_2_bids') {
                config.preempts = config.preempts || {};
                config.preempts.weak_two = config.preempts.weak_two || { enabled: enabled };
                config.preempts.weak_two.enabled = enabled;
            }

            // Meckwell UI (listed under notrump_defenses) -> strong_club_defenses.meckwell
            if (convention.key === 'meckwell') {
                config.strong_club_defenses = config.strong_club_defenses || {};
                config.strong_club_defenses.meckwell = config.strong_club_defenses.meckwell || { enabled: enabled };
                config.strong_club_defenses.meckwell.enabled = enabled;
            }

            // Unusual NT UI under Competitive -> notrump_defenses.unusual_nt
            if (convention.key === 'unusual_nt') {
                config.notrump_defenses = config.notrump_defenses || {};
                config.notrump_defenses.unusual_nt = config.notrump_defenses.unusual_nt || { enabled: enabled, direct: true, passed_hand: false, over_minors: !!(config?.notrump_defenses?.unusual_nt?.over_minors) };
                config.notrump_defenses.unusual_nt.enabled = enabled;
            }

            // Lebensohl UI under Competitive -> notrump_defenses.lebensohl
            if (convention.key === 'lebensohl') {
                config.notrump_defenses = config.notrump_defenses || {};
                config.notrump_defenses.lebensohl = config.notrump_defenses.lebensohl || { enabled: enabled, after_interference: true, fast_denies: true };
                config.notrump_defenses.lebensohl.enabled = enabled;
            }

            // Gerber UI under Slam Bidding -> ace_asking.gerber
            if (convention.key === 'gerber') {
                config.ace_asking = config.ace_asking || {};
                config.ace_asking.gerber = config.ace_asking.gerber || { enabled: enabled, continuations: true, responses_map: ['4D', '4H', '4S', '4NT'] };
                config.ace_asking.gerber.enabled = enabled;
            }

            // Blackwood variants UI -> ace_asking.blackwood (enabled + variant)
            if (convention.key === 'blackwood_regular') {
                config.ace_asking = config.ace_asking || {};
                config.ace_asking.blackwood = config.ace_asking.blackwood || { enabled: enabled, variant: 'classic', responses: (config?.ace_asking?.blackwood?.responses || '1430') };
                config.ace_asking.blackwood.enabled = enabled;
                if (enabled) config.ace_asking.blackwood.variant = 'classic';
            }
            if (convention.key === 'blackwood_rkcb') {
                config.ace_asking = config.ace_asking || {};
                config.ace_asking.blackwood = config.ace_asking.blackwood || { enabled: enabled, variant: 'rkcb', responses: (config?.ace_asking?.blackwood?.responses || '1430') };
                config.ace_asking.blackwood.enabled = enabled;
                if (enabled) config.ace_asking.blackwood.variant = 'rkcb';
            }
        } catch (e) {
            console.warn('Special-case convention mapping failed for', conventionName, e);
        }
    });

    // Post-processing: If both Blackwood variants are disabled, turn off ace_asking.blackwood entirely
    try {
        const regularOn = !!enabledConventions['Regular Blackwood'];
        // Dynamic RKCB label could be 1430 or 3014
        const rkcbLabel1 = 'RKC Blackwood 1430';
        const rkcbLabel2 = 'RKC Blackwood 3014';
        const rkcbOn = !!(enabledConventions[rkcbLabel1] || enabledConventions[rkcbLabel2]);
        if (!regularOn && !rkcbOn) {
            config.ace_asking = config.ace_asking || {};
            config.ace_asking.blackwood = config.ace_asking.blackwood || { enabled: false, variant: 'rkcb', responses: '1430' };
            config.ace_asking.blackwood.enabled = false;
        }
    } catch (_) { }

    pageLog('System conventions updated');
}

function generateBasicRandomHands() {
    const deck = createDeck();
    shuffleDeck(deck);

    currentHands.N = new window.Hand(convertCardsToHandString(deck.slice(0, 13)));
    currentHands.E = new window.Hand(convertCardsToHandString(deck.slice(13, 26)));
    currentHands.S = new window.Hand(convertCardsToHandString(deck.slice(26, 39)));
    currentHands.W = new window.Hand(convertCardsToHandString(deck.slice(39, 52)));
    try { if (typeof window !== 'undefined') window.currentHands = currentHands; } catch (_) { }
}

// Active practice targets used to annotate UI/explanations for the current deal
let activePracticeTargets = [];
try { if (typeof window !== 'undefined') window.activePracticeTargets = activePracticeTargets; } catch (_) { }

// Cached pool of pre-generated practice deals (loaded on demand)
let practiceDealPool = null;
let practiceDealPoolPromise = null;

async function loadPracticeDealPool() {
    try {
        if (practiceDealPool) return practiceDealPool;
        if (practiceDealPoolPromise) return practiceDealPoolPromise;
        if (typeof fetch !== 'function') return [];
        // Use a relative path that works when the app is served from project root
        practiceDealPoolPromise = fetch('./assets/data/practice_deals.json')
            .then(res => res.ok ? res.json() : [])
            .then(data => { practiceDealPool = Array.isArray(data) ? data : []; return practiceDealPool; })
            .catch(() => []);
        return practiceDealPoolPromise;
    } catch (_) {
        return [];
    }
}

function applyStoredDeal(deal, targetLabels) {
    if (!deal || !deal.hands) return false;
    try {
        currentHands.N = new window.Hand(deal.hands.N);
        currentHands.E = new window.Hand(deal.hands.E);
        currentHands.S = new window.Hand(deal.hands.S);
        currentHands.W = new window.Hand(deal.hands.W);
        try { if (typeof window !== 'undefined') window.currentHands = currentHands; } catch (_) { }
        activePracticeTargets = Array.isArray(targetLabels) ? targetLabels.slice() : [];
        try { if (typeof window !== 'undefined') window.activePracticeTargets = activePracticeTargets; } catch (_) { }
        addPracticeIndicator(targetLabels && targetLabels.length === 1 ? targetLabels[0] : targetLabels);
        return true;
    } catch (e) {
        console.warn('applyStoredDeal failed', e);
        return false;
    }
}

// Public helper to generate a fresh random deal and refresh UI
function generateRandomHands() {
    (async () => {
        try {
            resetAuctionForNewDeal();
            generationMode = 'random';
            activePracticeTargets = [];
            try { if (typeof window !== 'undefined') window.activePracticeTargets = activePracticeTargets; } catch (_) { }
            const practiceTargets = getSelectedPracticeTargets();
            let generated = false;
            let targetUsed = null;

            if (practiceTargets.length) {
                const attemptSets = [];
                if (practiceTargets.length > 1) attemptSets.push(practiceTargets); // try all
                attemptSets.push(...buildPairs(practiceTargets)); // try pairs
                attemptSets.push(...practiceTargets.map(t => [t])); // fall back to singles

                for (const set of attemptSets) {
                    if (generateConventionTargetedHand(set)) {
                        generated = true;
                        targetUsed = set;
                        break;
                    }
                }
            }

            if (practiceTargets.length && !generated) {
                const pool = await loadPracticeDealPool();
                const normalizedTargets = practiceTargets.map(normalizeConventionLabel);
                const matches = (pool || []).filter(d => {
                    const dealConventions = Array.isArray(d.conventions) ? d.conventions.map(normalizeConventionLabel) : [];
                    return normalizedTargets.every(t => dealConventions.includes(t));
                });
                if (matches.length) {
                    const shuffled = shuffleArrayInPlace(matches.slice());
                    for (const picked of shuffled) {
                        const hydrated = hydrateStoredDeal(picked);
                        const allOk = hydrated && normalizedTargets.every(t => validateDealForConvention(hydrated, t));
                        if (!allOk) continue;
                        if (applyStoredDeal(picked, normalizedTargets)) {
                            displayHands();
                            showAuctionSetup();
                            try { switchTab('auction'); } catch (_) { }
                            return;
                        }
                    }
                }
                pageLog(`Failed to generate practice hand for [${practiceTargets.join(', ')}] after multiple attempts`);
                showError(`Could not generate a practice hand for ${practiceTargets.join(', ')}. Please try again.`);
                return;
            }

            if (!generated) {
                generateBasicRandomHands();
                addPracticeIndicator(null);
            } else {
                addPracticeIndicator(targetUsed);
                activePracticeTargets = Array.isArray(targetUsed) ? targetUsed.slice() : [targetUsed];
                try { if (typeof window !== 'undefined') window.activePracticeTargets = activePracticeTargets; } catch (_) { }
            }

            displayHands();
            showAuctionSetup();
            // Auto-switch to Auction tab after generating a random deal
            try { switchTab('auction'); } catch (_) { }
        } catch (e) {
            console.error('generateRandomHands failed:', e);
            try {
                displayHands();
                showAuctionSetup();
            } catch (_) { }
        }
    })();
}

function selectTargetConvention(selectedConventions) {
    // If there's only one convention, use it
    if (selectedConventions.length === 1) {
        return selectedConventions[0];
    }

    // If multiple conventions are selected, try to find one that's compatible
    // For now, randomly select one
    return selectedConventions[Math.floor(Math.random() * selectedConventions.length)];
}

function generateConventionTargetedHand(target) {
    // Accept a single convention string or an array of conventions
    const targets = (Array.isArray(target) ? target : [target])
        .map(normalizeConventionLabel)
        .filter(Boolean);
    if (!targets.length) return false;

    // Try a larger number of attempts when aiming to satisfy multiple conventions
    const maxAttemptsAll = targets.length > 1 ? 900 : 900;

    // Fast path for very rare Strong 2C practice hands (22+ HCP opener)
    if (targets.includes('Strong 2 Clubs')) {
        if (generateStrong2CPracticeDeal(targets)) {
            pageLog('Generated Strong 2C practice deal');
            return true;
        }
        // If we somehow fail, fall back to generic loop below
    }

    for (let attempt = 0; attempt < maxAttemptsAll; attempt++) {
        generateBasicRandomHands();

        // Must satisfy all selected conventions when multiple were provided
        const allSatisfied = targets.every(conv => validateDealForConvention(currentHands, conv));
        if (allSatisfied) {
            pageLog(`Successfully generated hand for [${targets.join(', ')}] in ${attempt + 1} attempts`);
            return true;
        }
    }
    pageLog(`Failed to generate suitable hand for [${targets.join(', ')}] after ${maxAttemptsAll} attempts`);
    return false;
}

// Dedicated generator for Strong 2C practice (rare 22+ HCP deals)
function generateStrong2CPracticeDeal(targets) {
    const maxAttempts = 2000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const deck = createDeck();
        shuffleDeck(deck);

        // Deal south first to bias toward success without extra shuffling
        currentHands.S = new window.Hand(convertCardsToHandString(deck.slice(0, 13)));
        currentHands.N = new window.Hand(convertCardsToHandString(deck.slice(13, 26)));
        currentHands.E = new window.Hand(convertCardsToHandString(deck.slice(26, 39)));
        currentHands.W = new window.Hand(convertCardsToHandString(deck.slice(39, 52)));

        const allSatisfied = targets.every(conv => validateDealForConvention(currentHands, conv));
        if (allSatisfied) {
            pageLog(`Strong 2C deal found in ${attempt + 1} attempts`);
            return true;
        }
    }
    pageLog('Strong 2C generator failed after max attempts');
    return false;
}

// Build all unique unordered pairs from a list of labels
function buildPairs(list) {
    const uniq = Array.from(new Set(list.filter(Boolean)));
    const pairs = [];
    for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
            pairs.push([uniq[i], uniq[j]]);
        }
    }
    return pairs;
}

// Convert a stored deal (string hands) into Hand objects for validation without mutating UI state
function hydrateStoredDeal(deal) {
    try {
        if (!deal || !deal.hands) return null;
        const hydrated = {};
        ['N', 'E', 'S', 'W'].forEach(pos => {
            const str = deal.hands[pos];
            hydrated[pos] = str ? new window.Hand(str) : null;
        });
        return hydrated;
    } catch (_) {
        return null;
    }
}

// Fisher-Yates shuffle in-place for arrays
function shuffleArrayInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function validateHandForConvention(southHand, conventionName) {
    const normalized = normalizeConventionLabel(conventionName);
    switch (normalized) {
        case 'Strong 2 Clubs':
        case 'Strong 2C':
            return southHand.hcp >= 22;

        case 'Weak 2 Bids':
            return southHand.hcp >= 6 && southHand.hcp <= 10 &&
                (southHand.lengths.H === 6 || southHand.lengths.S === 6 || southHand.lengths.D === 6);

        case 'Jacoby 2NT':
            return southHand.hcp >= 13 &&
                (southHand.lengths.H >= 4 || southHand.lengths.S >= 4);

        case 'Splinter Bids':
            return southHand.hcp >= 13 &&
                (southHand.lengths.H >= 4 || southHand.lengths.S >= 4) &&
                (southHand.lengths.C <= 1 || southHand.lengths.D <= 1 ||
                    southHand.lengths.H <= 1 || southHand.lengths.S <= 1);

        case 'Gerber':
        case 'Regular Blackwood':
        case 'RKC Blackwood 1430':
            return southHand.hcp >= 18; // Base opener strength; full check done with both hands

        case 'DONT':
        case 'Meckwell':
            return southHand.hcp >= 8; // Enough to interfere over 1NT

        case 'Unusual NT': {
            // Require two lowest unbid suits. Accept any 5-5 among {C,D}, {C,H}, {D,H}.
            if (!southHand) return false;
            const hcpOk = southHand.hcp >= 8;
            const cd = (southHand.lengths.C || 0) >= 5 && (southHand.lengths.D || 0) >= 5;
            const ch = (southHand.lengths.C || 0) >= 5 && (southHand.lengths.H || 0) >= 5;
            const dh = (southHand.lengths.D || 0) >= 5 && (southHand.lengths.H || 0) >= 5;
            return hcpOk && (cd || ch || dh);
        }
        case 'Unusual NT (over minors)':
            return southHand.hcp >= 8 &&
                southHand.lengths.H >= 5 &&
                (southHand.lengths.C >= 5 || southHand.lengths.D >= 5);

        case 'Michaels': {
            if (!southHand) return false;
            const hcpOk = southHand.hcp >= 8;
            const majors55 = (southHand.lengths.H || 0) >= 5 && (southHand.lengths.S || 0) >= 5;
            return hcpOk && majors55;
        }

        case 'Negative Doubles':
        case 'Responsive Doubles':
        case 'Takeout Doubles':
        case 'Support Doubles':
        case 'Reopening Doubles':
            return southHand.hcp >= 6; // Minimum for doubles

        case 'Cue Bid Raises':
            return southHand.hcp >= 10 && // Need strength for cue bid raise
                (southHand.lengths.H >= 3 || southHand.lengths.S >= 3); // Need support

        case 'Drury':
            return southHand.hcp >= 8 && southHand.hcp <= 12 && // Drury range
                (southHand.lengths.H >= 3 || southHand.lengths.S >= 3); // Need major support

        case 'Bergen Raises':
            // Hands suitable for Bergen raises as responder: 4+ card support in a major and up to invitational values
            return southHand.hcp <= 12 && (southHand.lengths.H >= 4 || southHand.lengths.S >= 4);

        default:
            return southHand.hcp >= 12; // Generic opening hand strength
    }
}

// Lightweight NT helpers used only for practice hand generation
function isBalancedForNotrump(hand) {
    if (!hand || !hand.lengths) return false;
    const lens = ['S', 'H', 'D', 'C'].map(s => hand.lengths[s] || 0).sort((a, b) => b - a);
    const is4333 = lens[0] === 4 && lens[1] === 3 && lens[2] === 3 && lens[3] === 3;
    const is4432 = lens[0] === 4 && lens[1] === 4 && lens[2] === 3 && lens[3] === 2;
    const is5332 = lens[0] === 5 && lens[1] === 3 && lens[2] === 3 && lens[3] === 2;
    const include5422 = !!(system?.conventions?.config?.general?.balanced_shapes?.include_5422);
    const is5422 = include5422 && lens[0] === 5 && lens[1] === 4 && lens[2] === 2 && lens[3] === 2;
    return is4333 || is4432 || is5332 || is5422;
}

function isOneNTOpener(hand) {
    // Use standard 15-17 HCP range for 1NT openings with configured balanced shapes
    return !!hand && isBalancedForNotrump(hand) && hand.hcp >= 15 && hand.hcp <= 17;
}

function validateNotrumpResponseDeal(hands, conventionName) {
    // South is the opener in practice mode; North is the responder
    const opener = hands?.S;
    const responder = hands?.N;

    if (!isOneNTOpener(opener)) return false;

    switch (conventionName) {
        case 'Stayman': {
            const hasFourCardMajor = responder && ((responder.lengths?.H || 0) >= 4 || (responder.lengths?.S || 0) >= 4);
            const responderHcp = responder?.hcp || 0;
            return hasFourCardMajor && responderHcp >= 8; // enough values to look for a 4-card major
        }
        case 'Jacoby Transfers': {
            // Responder shows a 5-card major
            return responder && ((responder.lengths?.H || 0) >= 5 || (responder.lengths?.S || 0) >= 5);
        }
        case 'Texas Transfers': {
            // Responder has a 6-card major for a direct game try in a major
            return responder && ((responder.lengths?.H || 0) >= 6 || (responder.lengths?.S || 0) >= 6);
        }
        case 'Minor Suit Transfers': {
            // Responder has a long minor (6+) for 2S/2NT transfer sequences
            return responder && ((responder.lengths?.C || 0) >= 6 || (responder.lengths?.D || 0) >= 6);
        }
        default:
            return true; // fall through to opener check already satisfied
    }
}

function validateDealForConvention(hands, conventionName) {
    const normalized = normalizeConventionLabel(conventionName);
    const southHand = hands?.S;
    const northHand = hands?.N;
    switch (normalized) {
        case 'Michaels': {
            const opener = hands?.W;
            const overcaller = southHand;
            const openerOk = opener && opener.hcp >= 12;
            const majors55 = overcaller && (overcaller.lengths?.H || 0) >= 5 && (overcaller.lengths?.S || 0) >= 5;
            const hcpOk = overcaller && (overcaller.hcp || 0) >= 8;
            return openerOk && hcpOk && majors55;
        }
        case 'Regular Blackwood':
        case 'RKC Blackwood 1430': {
            if (!southHand || !northHand) return false;
            const combined = (southHand.hcp || 0) + (northHand.hcp || 0);
            const southStrong = (southHand.hcp || 0) >= 19;
            const hasFit = ['S', 'H', 'D', 'C'].some(s => (southHand.lengths?.[s] || 0) + (northHand.lengths?.[s] || 0) >= 8);
            return southStrong && combined >= 30 && hasFit;
        }
        case 'Stayman':
        case 'Jacoby Transfers':
        case 'Texas Transfers':
        case 'Minor Suit Transfers':
            return validateNotrumpResponseDeal(hands, normalized);
        default:
            return validateHandForConvention(southHand, normalized);
    }
}

function addPracticeIndicator(targetConvention) {
    // Remove any existing practice indicators
    const existingIndicators = document.querySelectorAll('.practice-indicator');
    existingIndicators.forEach(indicator => indicator.remove());

    if (!targetConvention) return;

    // Add new practice indicator
    const indicator = document.createElement('div');
    indicator.className = 'alert alert-info alert-dismissible fade show mt-2 practice-indicator';
    const label = Array.isArray(targetConvention) ? targetConvention.join(', ') : targetConvention;
    indicator.innerHTML = `
        <i class="bi bi-target"></i> <strong>Practice Mode:</strong> Hand generated for practicing <strong>${label}</strong>
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;

    const handCard = document.getElementById('handDisplayCard');
    if (handCard) {
        handCard.appendChild(indicator);
    }
}

// Tab switching functionality
function switchTab(tabName) {
    // Prevent entering Play tab unless auction has a playable contract
    if (tabName === 'play') {
        try {
            const playBtn = document.getElementById('playTab');
            if (playBtn && playBtn.disabled) {
                // Play is disabled — silently ignore the click (no modal alert)
                return; // do not switch
            }
        } catch (_) { /* ignore and proceed defensively */ }
    }
    // Hide all tab panels
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    // Remove active class from all tab buttons
    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });

    // Show selected tab panel
    document.getElementById(tabName + 'Panel').classList.add('active');

    // Add active class to selected tab button
    const activeBtn = document.getElementById(tabName + 'Tab');
    if (activeBtn) activeBtn.classList.add('active');

    // Toggle play-specific content style: hide outer tab border when Play is active
    try {
        const tabContent = document.querySelector('.tab-content');
        if (tabContent) {
            if (tabName === 'play') tabContent.classList.add('play-active');
            else tabContent.classList.remove('play-active');
        }
    } catch (e) { /* non-fatal */ }

    // Update tab progress underline (1..5 based on position among buttons)
    try {
        const nav = document.querySelector('.tab-nav');
        if (nav) {
            const buttons = Array.from(nav.querySelectorAll('.tab-button'));
            const idx = Math.max(1, buttons.findIndex(b => b === activeBtn) + 1);
            nav.style.setProperty('--progress', idx);
        }
    } catch (e) {
        // non-fatal
        console.warn('Failed to update tab progress:', e);
    }

    // If activating Play tab, render the play UI now
    try {
        if (tabName === 'play') {
            renderPlayTab();
            // Only run debug overlays when explicitly enabled (avoid UI noise)
            try { if (window && window.__debugPlayLayout) { debugPlayLayout(); } } catch (_) { /* ignore debug failures */ }
        }
    } catch (e) {
        console.warn('Failed to render Play tab:', e?.message || e);
    }
}

// Determine whether Play tab may be entered: auction complete and not all-pass
function canEnterPlay() {
    try {
        if (!isAuctionComplete()) return false;
        const last = getLastNonPassBid();
        return !!last; // if null => all pass
    } catch (_) { return false; }
}

// Update Play tab button enabled/disabled state according to auction outcome
function updatePlayTabState() {
    try {
        const btn = document.getElementById('playTab');
        if (!btn) return;
        const ok = canEnterPlay();
        btn.disabled = !ok;
        if (!ok) {
            btn.title = 'Disabled until auction completes with a contract';
            btn.classList.remove('active');
        } else {
            btn.title = 'Play the completed contract';
        }
    } catch (_) { /* no-op */ }
}

// Debug helper: draw temporary overlays around play-area elements and log computed styles.
function debugPlayLayout() {
    try {
        const enabled = (typeof window !== 'undefined' && window.__debugPageLogs === true) || DEFAULT_PAGE_DEBUG;
        if (!enabled) return;
        const ids = ['playNorthArea', 'playWestArea', 'playTableArea', 'playEastArea', 'playSouthArea', 'trickArea'];
        const colors = ['#ff7f7f', '#ffd07f', '#7fffd4', '#7fb3ff', '#c87fff', '#ffdf7f'];
        const overlays = [];
        ids.forEach((id, i) => {
            const el = document.getElementById(id);
            if (!el) return;
            const r = el.getBoundingClientRect();
            const ov = document.createElement('div');
            ov.style.position = 'fixed';
            ov.style.left = r.left + 'px';
            ov.style.top = r.top + 'px';
            ov.style.width = Math.max(2, r.width) + 'px';
            ov.style.height = Math.max(2, r.height) + 'px';
            ov.style.border = '3px dashed ' + colors[i % colors.length];
            ov.style.zIndex = 99999;
            ov.style.pointerEvents = 'none';
            ov.setAttribute('data-debug-for', id);
            const label = document.createElement('div');
            label.textContent = id;
            label.style.position = 'absolute';
            label.style.left = '4px';
            label.style.top = '4px';
            label.style.background = colors[i % colors.length];
            label.style.color = '#111';
            label.style.padding = '2px 6px';
            label.style.fontSize = '12px';
            label.style.fontWeight = '700';
            label.style.borderRadius = '4px';
            ov.appendChild(label);
            document.body.appendChild(ov);
            overlays.push(ov);
        });

        // Log computed style for trickArea
        const trick = document.getElementById('trickArea');
        if (trick) {
            const cs = window.getComputedStyle(trick);
            console.group('DEBUG: #trickArea computed styles');
            pageLog('width:', trick.offsetWidth, 'height:', trick.offsetHeight);
            pageLog('background-color:', cs.backgroundColor);
            pageLog('border-style:', cs.borderStyle, 'border-width:', cs.borderWidth, 'border-color:', cs.borderColor);
            pageLog('z-index:', cs.zIndex, 'position:', cs.position);
            pageLog('display:', cs.display, 'visibility:', cs.visibility, 'opacity:', cs.opacity);
            console.groupEnd();
        }

        // Log bounding rects and computed styles for play areas and CSS vars
        const playBoard = document.querySelector('.play-board');
        if (playBoard) {
            const pbCS = window.getComputedStyle(playBoard);
            console.group('DEBUG: .play-board and related values');
            pageLog('.play-board rect:', playBoard.getBoundingClientRect());
            pageLog('--trick-w:', pbCS.getPropertyValue('--trick-w'));
            pageLog('--play-card-width:', pbCS.getPropertyValue('--play-card-width'));
            console.groupEnd();
        }

        ['playWestArea', 'playEastArea', 'playTableArea'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const cs = window.getComputedStyle(el);
            console.group(`DEBUG: ${id}`);
            pageLog('rect:', el.getBoundingClientRect());
            pageLog('position:', cs.position, 'left:', cs.left, 'right:', cs.right, 'width:', cs.width);
            console.groupEnd();
        });

        // Make overlays removable by click (persist until user removes)
        const remover = (ev) => { overlays.forEach(o => o.remove()); document.removeEventListener('click', remover); };
        document.addEventListener('click', remover, { once: true });
    } catch (e) {
        console.warn('debugPlayLayout failed', e);
    }
}

// Helper function for startAuction compatibility
function showTab(tabId) {
    if (tabId === 'practice-bids') {
        switchTab('auction');
    } else {
        switchTab(tabId);
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', function () {
    // Add delay to ensure all scripts are loaded
    setTimeout(initializeSystem, 500);
    // Ensure Play tab button state is correct on load
    try { updatePlayTabState(); } catch (_) { }
    // Enhance bid buttons to color suit icons only on the buttons (not in the auction grid)
    try {
        enhanceBidButtonsSuitIcons();
    } catch (e) {
        console.warn('Failed to enhance bid button suits:', e);
    }
    // Compute equal chevron widths based on the longest label
    try {
        const setTabChevronWidths = () => {
            const nav = document.querySelector('.tab-nav');
            if (!nav) return;
            const buttons = Array.from(nav.querySelectorAll('.tab-button'));
            if (!buttons.length) return;
            // Reset widths to auto for accurate measurement
            buttons.forEach(b => { b.style.width = 'auto'; b.style.flexBasis = 'auto'; });
            // Prefer width of the "Active Conventions" tab
            const activeConventionsBtn = document.getElementById('activeTab');
            let targetWidth = 0;
            if (activeConventionsBtn) {
                targetWidth = Math.ceil(activeConventionsBtn.scrollWidth);
            }
            // Fallback: if not found or measured 0, use the maximum label width
            if (!targetWidth) {
                targetWidth = buttons.reduce((m, b) => Math.max(m, Math.ceil(b.scrollWidth)), 0);
            }
            // Add a tiny buffer to account for subpixel/font rounding
            nav.style.setProperty('--tab-width', (targetWidth + 2) + 'px');
        };
        setTabChevronWidths();
        // Recompute on window resize (debounced)
        let t;
        window.addEventListener('resize', () => {
            clearTimeout(t);
            t = setTimeout(setTabChevronWidths, 150);
        });
    } catch (e) {
        console.warn('Failed to set tab chevron widths:', e);
    }
});

// Enhance bid button labels by wrapping suit symbols with color classes
function enhanceBidButtonsSuitIcons() {
    const buttons = document.querySelectorAll('.bid-button');
    if (!buttons || !buttons.length) return;
    const wrapSuit = (text) => {
        if (!text || typeof text !== 'string') return text;
        // Avoid double-wrapping
        if (text.includes('<span')) return text;
        // Replace single suit symbols with colored spans
        return text
            .replace('♣', '<span class="card-suit suit-clubs">♣</span>')
            .replace('♦', '<span class="card-suit suit-diamonds">♦</span>')
            .replace('♥', '<span class="card-suit suit-hearts">♥</span>')
            .replace('♠', '<span class="card-suit suit-spades">♠</span>');
    };
    buttons.forEach(btn => {
        // Only transform the visible label, keep onclick handlers untouched
        const original = btn.innerHTML || btn.textContent;
        const transformed = wrapSuit(original);
        if (transformed !== original) {
            btn.innerHTML = transformed;
        }
    });
}

// =============================
// Play Tab: basic play-out UI
// =============================
let playState = {
    contract: null,         // e.g., { level: 4, strain: 'H'|'S'|'D'|'C'|'NT' }
    declarer: null,         // 'N'|'E'|'S'|'W'
    dummy: null,            // partner of declarer
    trump: null,            // same as contract.strain unless 'NT'
    leader: null,           // seat to lead the current trick
    nextSeat: null,         // who plays next
    trick: [],              // [{ seat, code }]
    played: new Set(),      // 'AS','TD', etc., across the whole hand
    dummyRevealed: false,
    contractSide: null,     // 'NS' or 'EW'
    lastLeadSuit: null,
    lastLeadSeat: null,
    tricksNS: 0,
    tricksEW: 0
};
try { if (typeof window !== 'undefined') window.playState = playState; } catch (_) { }
// Declarer planning state (two-step): { phase: 'draw'|'establish' }
playState.declarerPlan = null;

// In-memory play trace log (browser-only). Each entry is a short text line.
let playLog = [];
try { if (typeof window !== 'undefined') window.playLog = playLog; } catch (_) { }


function renderPlayTab() {
    try {
        appendPlayDebug('renderPlayTab: start');
        // Ensure playPanel is a child of .tab-content. Some browsers will
        // autocorrect malformed HTML and place nodes outside the intended
        // container; if that happens, move it back so tab logic and CSS
        // apply correctly.
        try {
            const tabContent = document.querySelector('.tab-content');
            const playPanelEl = document.getElementById('playPanel');
            if (tabContent && playPanelEl && playPanelEl.parentElement !== tabContent) {
                tabContent.appendChild(playPanelEl);
                appendPlayDebug('renderPlayTab: moved playPanel into .tab-content');
            }
        } catch (_) { }
        // Clear any pending status so the Play tab renders without transient banners
        try {
            const ps = document.getElementById('playStatus');
            if (ps) {
                ps.textContent = '';
                ps.className = 'alert';
                ps.style.display = 'none';
            }
        } catch (_) { }

        // In test/jsdom scenarios, window.currentHands may be the source of truth
        try { if (typeof window !== 'undefined' && window.currentHands) { currentHands = window.currentHands; } } catch (_) { }

        // If the Play panel is currently hidden (tab not active), don't force it
        // visible — instead defer rendering until it's activated. This prevents
        // showing Play content on the wrong tab while still ensuring renderPlayTab
        // will run when the panel becomes active via switchTab().
        try {
            const playPanel = document.getElementById('playPanel');
            if (playPanel) {
                const cs = window.getComputedStyle ? getComputedStyle(playPanel) : null;
                if (cs && cs.display === 'none') {
                    appendPlayDebug('renderPlayTab: panel is hidden; deferring render until activated');
                    // Watch for the 'active' class being added and then render once.
                    const mo = new MutationObserver((mutations, obs) => {
                        try {
                            const nowCs = getComputedStyle(playPanel);
                            if (playPanel.classList.contains('active') && nowCs.display !== 'none') {
                                appendPlayDebug('renderPlayTab: panel activated via mutation observer — rendering now');
                                obs.disconnect();
                                // Defer slightly to allow the browser layout to settle
                                setTimeout(() => { try { renderPlayTab(); } catch (_) { } }, 40);
                            }
                        } catch (_) { }
                    });
                    mo.observe(playPanel, { attributes: true, attributeFilter: ['class', 'style'] });
                    // Also set a safety timeout to attempt rendering in case mutation observer misses
                    setTimeout(() => {
                        try {
                            const cs2 = getComputedStyle(playPanel);
                            if (playPanel.classList.contains('active') && cs2.display !== 'none') {
                                appendPlayDebug('renderPlayTab: panel active (timeout check) — rendering now');
                                renderPlayTab();
                            } else {
                                appendPlayDebug('renderPlayTab: still hidden after timeout — aborting render');
                            }
                        } catch (_) { }
                    }, 500);
                    return; // abort this invocation — will rerun when panel activated
                }
            }
        } catch (_) { }

        // Compute final contract from auction history
        // Preserve any in-progress trick data (used by tests and mid-hand re-renders)
        const existingTrick = Array.isArray(playState.trick) ? playState.trick.slice() : [];
        const existingPlayed = playState.played instanceof Set ? new Set(playState.played) : new Set();

        const details = computePlayDetailsFromAuction();
        try { appendPlayDebug('renderPlayTab: computed details: ' + JSON.stringify({ contract: details.contract ? `${details.contract.level}${details.contract.strain}` : null, declarer: details.declarer, dummy: details.dummy })); } catch (_) { }
        playState.contract = details.contract;
        playState.declarer = details.declarer;
        playState.dummy = details.dummy;
        playState.trump = details.trump;
        playState.leader = details.leader;
        playState.nextSeat = details.leader;
        playState.trick = existingTrick.length ? existingTrick : [];
        playState.played = existingTrick.length ? existingPlayed : new Set();
        playState.dummyRevealed = false;
        playState.contractSide = details.contractSide;
        if (playState.trick.length) {
            try {
                playState.lastLeadSuit = playState.trick[0].code.slice(-1);
                playState.lastLeadSeat = playState.trick[0].seat;
            } catch (_) { playState.lastLeadSuit = null; playState.lastLeadSeat = null; }
        } else {
            playState.lastLeadSuit = null;
            playState.lastLeadSeat = null;
        }
        playState.tricksNS = 0;
        playState.tricksEW = 0;
        // Snapshot original hands for replay
        playState.originalHands = cloneHands(currentHands);
        // Initialize remaining counts for plan decisions
        try { computeRemainingCounts(); } catch (_) { }

        // Update Play titles to reflect declarer and dummy roles
        try {
            const northTitleEl = document.querySelector('#playNorthArea .hand-title');
            const southTitleEl = document.querySelector('#playSouthArea .hand-title');
            const westTitleEl = document.querySelector('#playWestArea .hand-title');
            const eastTitleEl = document.querySelector('#playEastArea .hand-title');
            if (northTitleEl && southTitleEl) {
                const decl = playState.declarer;
                const dum = playState.dummy;
                const northIsDummy = dum === 'N';
                const southIsDummy = dum === 'S';
                const northIsDeclarer = decl === 'N';
                const southIsDeclarer = decl === 'S';
                northTitleEl.textContent = northIsDummy ? 'North (Dummy)' : (northIsDeclarer ? 'North (Declarer)' : 'North');
                southTitleEl.textContent = southIsDummy ? 'South (Dummy)' : (southIsDeclarer ? 'South (Declarer)' : 'South (You)');
                // Also set East/West labels to indicate dummy if applicable
                try {
                    if (westTitleEl) {
                        const westIsDummy = dum === 'W';
                        const westIsDeclarer = decl === 'W';
                        westTitleEl.textContent = westIsDummy ? 'West (Dummy)' : (westIsDeclarer ? 'West (Declarer)' : 'West');
                    }
                    if (eastTitleEl) {
                        const eastIsDummy = dum === 'E';
                        const eastIsDeclarer = decl === 'E';
                        eastTitleEl.textContent = eastIsDummy ? 'East (Dummy)' : (eastIsDeclarer ? 'East (Declarer)' : 'East');
                    }
                } catch (_) { }
            }
        } catch (_) { }

        // Update contract info
        const info = document.getElementById('playContractInfo');
        if (info) {
            if (!details.contract) {
                info.textContent = 'Contract: — (All Pass)';
            } else {
                const side = (details.contractSide === 'NS' ? 'N-S' : 'E-W');
                const denom = details.contract.strain === 'NT' ? 'NT' : ({ S: '♠', H: '♥', D: '♦', C: '♣' }[details.contract.strain] || details.contract.strain);
                const dblTxt = details.contract.dbl === 1 ? 'x' : (details.contract.dbl === 2 ? 'xx' : '');
                info.textContent = `Contract: ${details.contract.level}${denom}${dblTxt ? ' ' + dblTxt : ''} by ${seatName(details.declarer)} (${side}) — Leader: ${seatName(details.leader)}`;
            }
        }

        // Render hands (South and Dummy if dummy is North)
        try {
            // Remove any lingering debug overlay elements left by earlier debug runs
            try { document.querySelectorAll('[data-debug-for]').forEach(el => el.remove()); } catch (_) { }
            appendPlayDebug('renderPlayTab: start rendering hands');
            const southRow = document.getElementById('playSouthHand');
            const northRow = document.getElementById('playNorthHand');
            if (southRow) southRow.innerHTML = '';
            if (northRow) northRow.innerHTML = '';

            // Reveal dummy only after the opening lead. Render hands using the
            // auction-style textual layout (suit groups) but create per-card
            // clickable elements for the Play tab instead of using CardSVG.render.
            const dummySeat = playState.dummy;
            // South's cards must always be clickable per requirements
            if (currentHands && currentHands.S) {
                try { appendPlayDebug('renderPlayTab: rendering South hand (clickable)'); } catch (_) { }
                renderPlayHand('playSouthHand', 'S', true);
            }
            // North's cards should only be visible when North is declarer or North is dummy.
            // When N-S are defenders (contractSide === 'EW'), North's hand should be hidden
            // but the engine will play for North automatically. If North is visible, make it clickable.
            // Additionally, when East or West is the dummy, do NOT show the North hand at all
            // (no card backs) so the layout matches E/W-dummy conventions.
            const dummyVisible = !!playState.dummyRevealed;
            const showNorth = (playState.declarer === 'N') || (dummyVisible && playState.dummy === 'N');
            const northClickable = !!showNorth && playState.declarer === 'N';
            if (currentHands && currentHands.N) {
                try { appendPlayDebug('renderPlayTab: showNorth=' + showNorth + ' northClickable=' + northClickable + ' dummy=' + playState.dummy + ' contractSide=' + playState.contractSide); } catch (_) { }
                if (!showNorth && northRow) {
                    // If North is dummy but not yet visible, show card backs; if North is a defender, show backs; otherwise hide.
                    northRow.innerHTML = '';
                    if (playState.dummy === 'N') {
                        renderCardBacks('playNorthHand', 'N');
                    } else if (playState.contractSide === 'EW') {
                        renderCardBacks('playNorthHand', 'N');
                    }
                } else if (showNorth) {
                    renderPlayHand('playNorthHand', 'N', !!northClickable);
                }
            }
            // East/West: show backs unless that seat is the dummy (then reveal its hand)
            const eastRow = document.getElementById('playEastHand');
            const westRow = document.getElementById('playWestHand');
            try {
                if (currentHands && currentHands.E) {
                    if (playState.dummy === 'E') {
                        if (eastRow) {
                            eastRow.innerHTML = '';
                            if (dummyVisible) {
                                renderPlayHand('playEastHand', 'E', false);
                            } else {
                                renderCardBacks('playEastHand', 'E');
                            }
                        }
                    } else {
                        if (eastRow) { eastRow.innerHTML = ''; renderCardBacks('playEastHand', 'E'); }
                    }
                }
                if (currentHands && currentHands.W) {
                    if (playState.dummy === 'W') {
                        if (westRow) {
                            westRow.innerHTML = '';
                            if (dummyVisible) {
                                renderPlayHand('playWestHand', 'W', false);
                            } else {
                                renderCardBacks('playWestHand', 'W');
                            }
                        }
                    } else {
                        if (westRow) { westRow.innerHTML = ''; renderCardBacks('playWestHand', 'W'); }
                    }
                }
            } catch (_) { }
        } catch (_) { }

        // Provide immediate DOM counts for diagnosis (south/north child counts)
        try { const southCnt = document.getElementById('playSouthHand')?.childElementCount; const northCnt = document.getElementById('playNorthHand')?.childElementCount; appendPlayDebug('renderPlayTab: DOM counts south=' + (typeof southCnt === 'number' ? southCnt : 'none') + ' north=' + (typeof northCnt === 'number' ? northCnt : 'none')); } catch (_) { }

        // Layout guard removed: rely on scoped CSS rules in `css/bidding.css`
        // (e.g. `.tab-panel.active#playPanel` and `.card-button` sizing) to
        // prevent Play area collapse across browsers. This keeps DOM untouched
        // and avoids transient inline style changes.

        // Reset trick area: ensure per-seat slots are present and empty
        const trickArea = document.getElementById('trickArea');
        if (trickArea) {
            // Clear any previous inline styles (e.g., left/top/width) so CSS grid drives layout
            try { trickArea.removeAttribute('style'); } catch (_) { }
            trickArea.innerHTML = '';
            const slots = ['N', 'E', 'S', 'W'];
            slots.forEach(s => {
                const slot = document.createElement('div');
                slot.className = `trick-slot trick-slot-${s === 'N' ? 'north' : s === 'S' ? 'south' : s === 'E' ? 'east' : 'west'}`;
                slot.dataset.seat = s;
                trickArea.appendChild(slot);
            });
            const hint = document.createElement('div');
            hint.className = 'trick-hint';
            hint.textContent = 'Click a card to play';
            trickArea.appendChild(hint);
        }

        // Reset counts and status/result
        try { document.getElementById('trickCountNS').textContent = '0'; } catch (_) { }
        try { document.getElementById('trickCountEW').textContent = '0'; } catch (_) { }
        try { const scoreEl = document.getElementById('playInlineScore'); if (scoreEl) scoreEl.textContent = ''; } catch (_) { }
        try { const rs = document.getElementById('playResultSummary'); if (rs) { rs.textContent = ''; rs.style.display = 'none'; } } catch (_) { }
        try { const ul = document.getElementById('playScoreBreakdown'); if (ul) { ul.innerHTML = ''; ul.style.display = 'none'; } } catch (_) { }
        // Do not show transient status banners on initial render; leave status area hidden
        try {
            const ps = document.getElementById('playStatus');
            if (ps) {
                ps.textContent = '';
                ps.style.display = 'none';
            }
        } catch (_) { }

        // If next to play is E/W, auto-play to keep the trick moving
        try { if (typeof updateLeadHighlight === 'function') updateLeadHighlight(); } catch (_) { }
        setTimeout(() => autoPlayIfNeeded(), 200);
        try { appendPlayDebug('renderPlayTab: finished'); } catch (_) { }
        // Positioning for East/West seats now relies solely on CSS grid to avoid
        // runtime inline shifts during render.
    } catch (e) {
        // Ensure user sees an error instead of a blank Play tab
        try { showPlayStatus('Failed to render Play view: ' + (e?.message || e), 'danger'); } catch (_) { }
        try { appendPlayDebug('renderPlayTab: ERROR -> ' + (e?.message || String(e))); } catch (_) { }
        console.error('renderPlayTab error:', e);
    }
}

// Expose helpers for reliable navigation and rendering from UI
try {
    if (typeof window !== 'undefined') {
        // Ensure callable from tests and inline handlers
        window.renderPlayTab = renderPlayTab;
        window.goToPlay = function () {
            try {
                const btn = document.getElementById('playTab');
                if (btn) {
                    btn.disabled = false;
                    btn.title = 'Play the completed contract';
                    try { btn.focus(); } catch (_) { }
                }
            } catch (_) { }
            try { switchTab('play'); } catch (_) { }
            try { renderPlayTab(); } catch (_) { }
        };
    }
} catch (_) { }

// Make Play helpers accessible for inline handlers and external calls
try { window.renderPlayTab = renderPlayTab; } catch (_) { }
try {
    window.goToPlay = function () {
        try {
            const btn = document.getElementById('playTab');
            if (btn) {
                btn.disabled = false;
                btn.title = 'Play the completed contract';
                try { btn.focus(); } catch (_) { }
            }
        } catch (_) { }
        try { switchTab('play'); } catch (_) { }
        try { renderPlayTab(); } catch (_) { }
    };
} catch (_) { }

function computePlayDetailsFromAuction() {
    // Find last contract and who declared
    let finalIdx = -1;
    let finalToken = null;
    let finalSeat = null;
    for (let i = auctionHistory.length - 1; i >= 0; i--) {
        const tok = auctionHistory[i]?.bid?.token || null;
        if (tok && /^[1-7](C|D|H|S|NT)$/.test(tok)) {
            finalIdx = i; finalToken = tok; finalSeat = auctionHistory[i].position; break;
        }
    }
    if (finalIdx === -1) {
        return { contract: null, declarer: null, dummy: null, trump: null, leader: null, contractSide: null };
    }
    const level = parseInt(finalToken[0], 10);
    const strain = finalToken.slice(1);
    const sideSeats = (['N', 'S'].includes(finalSeat)) ? ['N', 'S'] : ['E', 'W'];
    let declarer = null;
    for (let i = 0; i < auctionHistory.length; i++) {
        const e = auctionHistory[i];
        if (!e || !sideSeats.includes(e.position)) continue;
        const tok = e.bid?.token || null;
        if (!tok) continue;
        if (strain === 'NT') {
            if (/^[1-7]NT$/.test(tok)) { declarer = e.position; break; }
        } else {
            if (new RegExp(`^[1-7]${strain}$`).test(tok)) { declarer = e.position; break; }
        }
    }
    // Fallback if not found (shouldn’t happen often): use last bidder’s seat
    if (!declarer) declarer = finalSeat;
    const dummy = partnerOf(declarer);
    // Detect double/redouble on the final contract
    let dbl = 0; // 0=undoubled,1=doubled,2=redoubled
    for (let i = finalIdx + 1; i < auctionHistory.length; i++) {
        const tok = auctionHistory[i]?.bid?.token || 'PASS';
        if (tok === 'X') { dbl = 1; }
        else if (tok === 'XX') { dbl = 2; }
        else if (tok !== 'PASS') { dbl = 0; } // any further contract bid resets notion
    }
    const trump = (strain === 'NT') ? null : strain;
    const leader = leftOf(declarer);
    const side = sideSeats.includes('N') ? 'NS' : 'EW';
    return { contract: { level, strain, dbl }, declarer, dummy, trump, leader, contractSide: side };
}

function renderHandCards(containerId, seat) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const hand = currentHands?.[seat];
    if (!hand || !hand.suitBuckets) return;
    // Determine suit display order: start with trump suit and keep Black suits first
    const trump = (typeof playState !== 'undefined' && playState?.trump) ? playState.trump : null;
    const suits = getSuitOrder(trump);
    const order = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
    suits.forEach(s => {
        const cards = (hand.suitBuckets[s] || []).slice().sort((a, b) => order.indexOf(a.rank) - order.indexOf(b.rank));
        try { appendPlayDebug(`renderHandCards: ${seat} processing suit ${s} (${cards.map(c => c.rank).join('')})`); } catch (_) { }
        cards.forEach(c => {
            const code = `${c.rank}${s}`;
            const svgEl = (window.CardSVG && window.CardSVG.render) ? window.CardSVG.render(code, { width: 72, height: 108 }) : null;
            if (svgEl) {
                const button = wrapCardWithSeat(svgEl, code, seat);
                if (button) {
                    container.appendChild(button);
                }
            }
        });
    });
}

/**
 * Render a play-friendly hand into the Play tab.
 * Uses auction-style textual grouping but creates per-card buttons so
 * South (and dummy when appropriate) can click to play.
 * containerId - id of element to populate
 * seat - 'N'|'S' etc.
 * clickable - boolean whether cards should be interactive (click to play)
 */
function renderPlayHand(containerId, seat, clickable) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const hand = currentHands?.[seat];
    if (!hand || !hand.suitBuckets) return;
    container.innerHTML = '';
    // When N/S are defending, hide partner's hand (North) unless North is dummy
    try {
        const contractSide = playState?.contractSide || null;
        if (seat === 'N' && contractSide === 'EW' && playState?.dummy !== 'N') {
            renderCardBacks(containerId, seat);
            return;
        }
    } catch (_) { }
    // Safety guard: East/West should only display full hands when they are the dummy.
    // If this function is mistakenly invoked for E/W when they are not dummy, render
    // compact card-backs instead and exit early to avoid showing center 'ghost' glyphs.
    try {
        if ((seat === 'E' || seat === 'W') && !(playState && playState.dummy === seat)) {
            renderCardBacks(containerId, seat);
            return;
        }
    } catch (_) { }
    const trump = (typeof playState !== 'undefined' && playState?.trump) ? playState.trump : null;
    const suits = getSuitOrder(trump);
    const order = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

    // Decide whether to render this seat as a single overlapping row (like N/S).
    const treatAsSingleRow = (seat === 'S' || seat === 'N' || (typeof playState !== 'undefined' && playState?.dummy === seat));

    // Render as SVG cards so visible hands match played card visuals.
    if (treatAsSingleRow) {
        // Render all cards in a single row for South/North
        const row = document.createElement('div');
        row.className = 'ns-cards-row';
        // Force inline layout so CSS caching or specificity can't prevent overlap
        try {
            row.style.display = 'flex';
            row.style.gap = '0px';
            row.style.flexWrap = 'nowrap';
            row.style.justifyContent = 'center';
            row.style.alignItems = 'center';
            row.style.padding = '0';
        } catch (_) { }
        suits.forEach(s => {
            const cards = (hand.suitBuckets[s] || []).slice().sort((a, b) => order.indexOf(a.rank) - order.indexOf(b.rank));
            let idx = row.childElementCount || 0;
            cards.forEach(c => {
                const code = `${c.rank}${s}`;
                // For dummy (non-clickable) hands prefer showing the suit symbol in the
                // center rather than the large rank letter to avoid 'ghost' rank letters
                // overlaying the UI when dummy is rendered non-interactively.
                const svgOpts = { width: 120, height: 170 };
                // Do not force center-as-suit for dummy E/W — dummy should look identical
                // to N/S single-row rendering (i.e., show ranks in center where appropriate).
                const svgEl = (window.CardSVG && window.CardSVG.render) ? window.CardSVG.render(code, svgOpts) : null;
                try {
                    if (!clickable && typeof playState !== 'undefined' && playState?.dummy === seat && svgEl) {
                        svgEl.setAttribute('data-dummy-card', 'true');
                    }
                } catch (_) { }
                if (svgEl) {
                    // shrink by 20% vertically (and scale width proportionally)
                    try {
                        const origW = parseInt(svgEl.getAttribute('width') || '120', 10) || 120;
                        const origH = parseInt(svgEl.getAttribute('height') || '170', 10) || 170;
                        const newW = Math.round(origW * 0.8);
                        const newH = Math.round(origH * 0.8);
                        svgEl.setAttribute('width', String(newW));
                        svgEl.setAttribute('height', String(newH));
                        svgEl.style.width = newW + 'px';
                        svgEl.style.height = newH + 'px';
                        // Prevent any SVG text from overflowing the card bounds
                        try { svgEl.setAttribute('overflow', 'hidden'); svgEl.style.overflow = 'hidden'; } catch (_) { }
                    } catch (_) { }
                    const btn = wrapCardWithSeat(svgEl, code, seat);
                    if (btn) {
                        if (!clickable) {
                            try { btn.removeEventListener('click', onCardClick); } catch (_) { }
                            btn.disabled = true;
                            btn.classList.add('non-clickable');
                        }
                        // Apply overlap via inline margin so CSS precedence is irrelevant
                        try {
                            if (idx === 0) btn.style.marginLeft = '0px';
                            else {
                                const overlap = Math.round((parseInt(svgEl.getAttribute('width') || '96', 10) || 96) * 0.75);
                                btn.style.marginLeft = `-${overlap}px`;
                            }
                            // ensure stacking order
                            btn.style.position = 'relative';
                            btn.style.zIndex = String(idx + 1);
                        } catch (_) { }
                        row.appendChild(btn);
                        idx++;
                    }
                }
            });
        });
        container.appendChild(row);
    } else {
        // East/West: preserve 4 suit rows (one per suit)
        suits.forEach(s => {
            const cards = (hand.suitBuckets[s] || []).slice().sort((a, b) => order.indexOf(a.rank) - order.indexOf(b.rank));
            if (!cards.length) return;
            const suitGroup = document.createElement('div');
            suitGroup.className = 'hand-suit';
            const cardsRow = document.createElement('div');
            cardsRow.className = 'suit-cards-row';
            // make suit rows non-wrapping and overlapping too
            try { cardsRow.style.display = 'flex'; cardsRow.style.gap = '0px'; cardsRow.style.flexWrap = 'nowrap'; cardsRow.style.alignItems = 'center'; } catch (_) { }
            cards.forEach(c => {
                const code = `${c.rank}${s}`;
                // For East/West suit rows, if this seat is the dummy and cards are non-clickable
                // render the center as suit glyphs to avoid prominent rank letters lingering.
                const svgOpts = { width: 120, height: 170 };
                const svgEl = (window.CardSVG && window.CardSVG.render) ? window.CardSVG.render(code, svgOpts) : null;
                try {
                    if (!clickable && typeof playState !== 'undefined' && playState?.dummy === seat && svgEl) {
                        svgEl.setAttribute('data-dummy-card', 'true');
                    }
                } catch (_) { }
                if (svgEl) {
                    try {
                        const origW = parseInt(svgEl.getAttribute('width') || '120', 10) || 120;
                        const origH = parseInt(svgEl.getAttribute('height') || '170', 10) || 170;
                        const newW = Math.round(origW * 0.8);
                        const newH = Math.round(origH * 0.8);
                        svgEl.setAttribute('width', String(newW));
                        svgEl.setAttribute('height', String(newH));
                        svgEl.style.width = newW + 'px';
                        svgEl.style.height = newH + 'px';
                        // Prevent any SVG text from overflowing the card bounds
                        try { svgEl.setAttribute('overflow', 'hidden'); svgEl.style.overflow = 'hidden'; } catch (_) { }
                    } catch (_) { }
                    const btn = wrapCardWithSeat(svgEl, code, seat);
                    if (btn) {
                        if (!clickable) {
                            try { btn.removeEventListener('click', onCardClick); } catch (_) { }
                            btn.disabled = true;
                            btn.classList.add('non-clickable');
                        }
                        try {
                            // overlap suit rows slightly
                            if (cardsRow.childElementCount > 0) {
                                const overlap = Math.round((parseInt(svgEl.getAttribute('width') || '96', 10) || 96) * 0.75);
                                btn.style.marginLeft = `-${overlap}px`;
                            } else { btn.style.marginLeft = '0px'; }
                            btn.style.position = 'relative';
                            btn.style.zIndex = String(cardsRow.childElementCount + 1);
                        } catch (_) { }
                        cardsRow.appendChild(btn);
                    }
                }
            });
            suitGroup.appendChild(cardsRow);
            container.appendChild(suitGroup);
        });
    }
}

// Helper: returns suit rendering order. Keeps Black suits first then Red suits,
// but rotates the order so the trump suit (if provided) appears first.
function getSuitOrder(trump) {
    // For No Trump, explicit order per spec: S,H,C,D
    if (!trump) return ['S', 'H', 'C', 'D'];
    // Ensure visual alternation of colors while keeping trump first.
    // Colors: black = [S,C], red = [H,D]. We'll start with trump, then pick a
    // suit of the opposite color, then the remaining black, then remaining red.
    const blacks = ['S', 'C'];
    const reds = ['H', 'D'];
    const up = (s) => (blacks.includes(s) ? 'black' : (reds.includes(s) ? 'red' : null));
    const trumpColor = up(trump);
    // Build order starting with trump
    const order = [trump];
    // choose a suit from opposite color (prefer conventional order H then D for reds, S then C for blacks)
    if (trumpColor === 'black') {
        // pick a red suit (prefer H then D)
        for (const r of reds) if (!order.includes(r)) { order.push(r); break; }
        // then remaining black (non-trump)
        for (const b of blacks) if (!order.includes(b)) order.push(b);
        // then remaining red
        for (const r of reds) if (!order.includes(r)) order.push(r);
    } else if (trumpColor === 'red') {
        // pick a black suit (prefer S then C)
        for (const b of blacks) if (!order.includes(b)) { order.push(b); break; }
        // then remaining red (non-trump)
        for (const r of reds) if (!order.includes(r)) order.push(r);
        // then remaining black
        for (const b of blacks) if (!order.includes(b)) order.push(b);
    } else {
        // Fallback: default alternating sequence
        return ['S', 'H', 'C', 'D'];
    }
    return order;
}

/**
 * Render a compact card-back stack into a container for a hidden hand.
 * Shows a small stacked visual plus a count badge.
 */
function renderCardBacks(containerId, seat) {
    try {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        const hand = currentHands?.[seat];
        const count = hand ? (hand.suitBuckets?.S?.length || 0) + (hand.suitBuckets?.H?.length || 0) + (hand.suitBuckets?.D?.length || 0) + (hand.suitBuckets?.C?.length || 0) : 0;
        const stack = document.createElement('div');
        stack.className = 'card-back-stack';
        // Create up to 3 visible backs for a nice stacked look
        const layers = Math.min(3, Math.max(1, Math.ceil(count / 5)));
        for (let i = 0; i < layers; i++) {
            const b = document.createElement('div');
            b.className = 'card-back';
            // Ensure PNG card-back is used (inline style to avoid CSS/path overrides)
            try { b.style.backgroundImage = "url('cards/card_back.png')"; b.style.backgroundSize = 'cover'; b.style.backgroundPosition = 'center'; } catch (_) { }
            stack.appendChild(b);
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'card-backs';
        wrapper.appendChild(stack);
        // Do not show numeric count badge - removed per UX request
        container.appendChild(wrapper);
    } catch (_) { }
}

function wrapCardWithSeat(svgEl, code, seat) {
    if (!svgEl) return null;
    try {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'card-button';
        btn.dataset.code = code;
        btn.dataset.seat = seat;
        btn.addEventListener('click', onCardClick);
        // Defensive inline sizing for SVG-wrapped buttons
        try { btn.style.display = 'inline-flex'; btn.style.minWidth = '44px'; btn.style.minHeight = '28px'; btn.style.alignItems = 'center'; btn.style.justifyContent = 'center'; } catch (_) { }
        svgEl.dataset.code = code;
        svgEl.dataset.seat = seat;
        btn.appendChild(svgEl);
        return btn;
    } catch (_) {
        return svgEl;
    }
}

function onCardClick(ev) {
    try {
        const el = ev.currentTarget;
        const code = el?.dataset?.code;
        const seat = el?.dataset?.seat;
        if (!code || !seat) return;
        // Prevent playing cards for the next trick until the user has
        // acknowledged the previous trick by clicking the table (awaitingContinue).
        if (playState && playState.awaitingContinue) return;
        // Only allow clicks for South or North, and only when it’s their turn
        if (!['S', 'N'].includes(seat)) return;
        if (seat !== playState.nextSeat) return;
        if (playState.played.has(code)) return;

        // Enforce follow-suit if required
        if (!canPlayCode(seat, code)) {
            showPlayStatus('You must follow suit if able.', 'danger');
            return;
        }

        // Remove from hand UI
        try { el.removeEventListener('click', onCardClick); } catch (_) { }
        try { el.parentElement?.removeChild(el); } catch (_) { }

        // Remove from underlying hand state
        try { removeCodeFromHand(currentHands?.[seat], code); } catch (_) { }

        playCardToTrick(seat, code);
        // Proceed to next seat
        playState.nextSeat = leftOf(playState.nextSeat);
        // Auto-play for opponents if they’re up
        setTimeout(() => autoPlayIfNeeded(), 250);
    } catch (e) {
        console.warn('onCardClick failed:', e?.message || e);
    }
}

async function autoPlayIfNeeded() {
    try {
        // Do not auto-play while awaiting user to acknowledge completed trick
        if (playState && playState.awaitingContinue) return;
        // Play while it's an automated seat (E/W always; N when N-S are defenders)
        const isAutomatedSeat = (seat) => {
            if (!seat) return false;
            if (seat === 'E' || seat === 'W') return true;
            if (seat === 'N') return (playState.contractSide === 'EW'); // North automated when N-S are defenders
            return false;
        };
        while (playState.nextSeat && isAutomatedSeat(playState.nextSeat) && playState.trick.length < 4) {
            const seat = playState.nextSeat;
            // Prevent the same seat from acting twice in a single trick
            try {
                if ((playState.trick || []).some(t => t.seat === seat)) {
                    playState.nextSeat = leftOf(playState.nextSeat);
                    continue;
                }
            } catch (_) { }
            const code = await pickAutoCardFor(seat);
            if (!code) break;
            playCardToTrick(seat, code);
            playState.nextSeat = leftOf(playState.nextSeat);
        }
    } catch (e) {
        console.warn('autoPlayIfNeeded failed:', e?.message || e);
    }
}

function getLegalPlaysFor(seat) {
    const hand = currentHands?.[seat];
    if (!hand || !hand.suitBuckets) return [];
    const allCards = [];
    ['S', 'H', 'D', 'C'].forEach(suit => {
        (hand.suitBuckets[suit] || []).forEach(c => allCards.push(c.rank + suit));
    });

    const leadSuit = playState.trick.length ? playState.trick[0].code.slice(-1) : null;
    if (!leadSuit) return allCards; // Leading: any card is legal

    // If following suit, must play lead suit if available
    const followCards = allCards.filter(c => c.slice(-1) === leadSuit);
    if (followCards.length > 0) return followCards;

    // Otherwise any card is legal
    return allCards;
}

async function pickAutoCardFor(seat) {
    try { pageLog('DEBUG: pickAutoCardFor playState.contract:', playState?.contract); } catch (_) { }
    try {
        if (typeof window !== 'undefined' && window.__DEBUG_DISCARD) {
            // debug print removed
        }
    } catch (_) { }
    // If tests set `window.currentHands` or `window.playState`, sync module variables so we operate on test hands/state
    try { if (typeof window !== 'undefined' && window.currentHands) currentHands = window.currentHands; } catch (_) { }
    try { if (typeof window !== 'undefined' && window.playState) playState = window.playState; } catch (_) { }


    const hand = currentHands?.[seat];
    if (!hand) return null;

    const legalPlays = getLegalPlaysFor(seat);
    if (!legalPlays || legalPlays.length === 0) {
        return null; // No legal plays
    }

    const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const rankIndex = (code) => rankOrder.indexOf((code || '2')[0]);
    const sortAsc = (arr) => arr.slice().sort((a, b) => rankIndex(a) - rankIndex(b));
    const sortDesc = (arr) => arr.slice().sort((a, b) => rankIndex(b) - rankIndex(a));
    const suitOrder = ['S', 'H', 'D', 'C'];
    const sameSide = (s) => {
        if (!playState?.contractSide) return false;
        if (playState.contractSide === 'NS') return s === 'N' || s === 'S';
        return s === 'E' || s === 'W';
    };

    const selectCardToPlay = () => {
        const lead = (playState.trick && playState.trick[0]) || null;
        const leadSuit = lead ? lead.code.slice(-1) : null;
        const hasLeadSuit = leadSuit && legalPlays.some(c => c.endsWith(leadSuit));
        const ourSide = sameSide(seat);
        const leaderSideMatches = lead ? sameSide(lead.seat) === ourSide : false;
        const trump = playState?.trump || null;
        const partner = partnerOf(seat);
        try {
            if (!playState.holdUpSuits) playState.holdUpSuits = {};
            if (!playState.throwInSuits) playState.throwInSuits = {};
        } catch (_) { }
        try { if ((playState?.trick?.length || 0) === 0) playState.finessePlan = null; } catch (_) { }
        const finessePlan = playState?.finessePlan || null;
        const suitLen = (s, h) => ((h?.suitBuckets?.[s] || []).length || 0);
        const combinedLen = (s) => suitLen(s, currentHands?.[seat]) + suitLen(s, currentHands?.[partner]);
        const combinedHonorCount = (s) => {
            const honors = new Set(['A', 'K', 'Q', 'J']);
            let count = 0;
            (currentHands?.[seat]?.suitBuckets?.[s] || []).forEach(c => { if (honors.has(c.rank)) count++; });
            (currentHands?.[partner]?.suitBuckets?.[s] || []).forEach(c => { if (honors.has(c.rank)) count++; });
            return count;
        };
        const combinedTrumpLen = (() => {
            if (!trump) return 0;
            const ours = suitLen(trump, currentHands?.[seat]);
            const partnerLen = suitLen(trump, currentHands?.[partner]);
            return ours + partnerLen;
        })();
        const oppTrumpLeft = (() => {
            try {
                return (playState?.opponentsCombined && typeof playState.opponentsCombined[trump] === 'number')
                    ? playState.opponentsCombined[trump]
                    : null;
            } catch (_) { return null; }
        })();
        const trumpHonorCount = (() => {
            if (!trump) return 0;
            const honors = new Set(['A', 'K', 'Q', 'J']);
            let count = 0;
            (currentHands?.[seat]?.suitBuckets?.[trump] || []).forEach(c => { if (honors.has(c.rank)) count++; });
            (currentHands?.[partner]?.suitBuckets?.[trump] || []).forEach(c => { if (honors.has(c.rank)) count++; });
            return count;
        })();
        const shortSuitRuffPotential = (() => {
            if (!trump) return false;
            const suits = ['S', 'H', 'D', 'C'];
            for (const s of suits) {
                if (s === trump) continue;
                const lenSeat = suitLen(s, currentHands?.[seat]);
                const lenPartner = suitLen(s, currentHands?.[partner]);
                if (Math.min(lenSeat, lenPartner) <= 1 && Math.max(lenSeat, lenPartner) >= 3) return true;
            }
            return false;
        })();
        const entryCount = (() => {
            const suits = ['S', 'H', 'D', 'C'];
            let c = 0;
            for (const s of suits) {
                if (s === trump) continue;
                if (suitLen(s, currentHands?.[seat]) > 0) c++;
                if (suitLen(s, currentHands?.[partner]) > 0) c++;
            }
            return c;
        })();
        // Defense signal memory (shared via playState)
        const defensePreferredSuit = playState?.defensePreferredSuit || null;
        const defenseDiscourageSuit = playState?.defenseDiscourageSuit || null;
        const holdUpSuits = playState?.holdUpSuits || null;
        const throwInSuits = playState?.throwInSuits || null;
        const lastLeadSeat = playState?.lastLeadSeat || null;
        const lastLeadFromOurSide = lastLeadSeat ? sameSide(lastLeadSeat) === ourSide : false;
        const cardsInSuit = (s, handObj) => (handObj?.suitBuckets?.[s] || []).map(c => `${c.rank}${s}`);
        const pickLowest = (arr) => arr.slice().sort((a, b) => rankIndex(a) - rankIndex(b))[0];
        const pickLowestSpot = (arr) => {
            const spots = arr.filter(c => !['A', 'K', 'Q', 'J', 'T'].includes(c[0]));
            return spots.length ? pickLowest(spots) : pickLowest(arr);
        };

        // Simple declarer finesse plan: if partner holds a tenace (AQ, KJ with ace support, QJ with top cover), lead low toward it and ask partner to play the honor third hand.
        const chooseFinesseLead = () => {
            if (leadSuit) return null;
            if (!ourSide) return null;
            const suits = ['S', 'H', 'D', 'C'].filter(s => s !== trump);
            for (const s of suits) {
                const myCards = cardsInSuit(s, currentHands?.[seat]);
                if (!myCards.length) continue;
                const partnerCards = cardsInSuit(s, currentHands?.[partner]);
                if (partnerCards.length < 2) continue;
                const partnerRanks = new Set(partnerCards.map(c => c[0]));
                const combinedRanks = new Set([...myCards, ...partnerCards].map(c => c[0]));
                const setPlan = (targetHonor) => {
                    try { playState.finessePlan = { suit: s, target: targetHonor, honorSeat: partner }; } catch (_) { }
                    return pickLowestSpot(myCards);
                };
                if (partnerRanks.has('A') && partnerRanks.has('Q') && !combinedRanks.has('K')) {
                    return setPlan('Q');
                }
                if (partnerRanks.has('K') && partnerRanks.has('J') && combinedRanks.has('A') && !combinedRanks.has('Q')) {
                    return setPlan('J');
                }
                if (partnerRanks.has('Q') && partnerRanks.has('J') && combinedRanks.has('A') && !combinedRanks.has('K')) {
                    return setPlan('Q');
                }
            }
            return null;
        };

        const trickTargetSuit = (() => {
            if (!leadSuit) return null;
            const trumpPlayed = playState.trump && playState.trick.some(t => t.code.endsWith(playState.trump));
            return trumpPlayed ? playState.trump : leadSuit;
        })();
        const highestInTarget = (() => {
            if (!trickTargetSuit) return -1;
            let best = -1;
            (playState.trick || []).forEach(t => {
                if (t.code.endsWith(trickTargetSuit)) {
                    best = Math.max(best, rankIndex(t.code));
                }
            });
            return best;
        })();
        const winningCards = (cards) => cards.filter(c => c.endsWith(trickTargetSuit) && rankIndex(c) > highestInTarget);

        const handCount = (() => {
            const suits = ['S', 'H', 'D', 'C'];
            return suits.reduce((sum, s) => sum + suitLen(s, currentHands?.[seat]), 0);
        })();

        // If we are on lead, pick a suit/card with NT/trump awareness and honor safety.
        if (!leadSuit) {
            const isNTContract = !trump;
            // Prefer a clear establishment suit for declarer: longest combined non-trump with honors
            let establishSuit = null;
            if (ourSide) {
                const estCandidates = ['S', 'H', 'D', 'C']
                    .filter(s => s !== trump)
                    .map(s => {
                        const len = combinedLen(s);
                        const honorCount = combinedHonorCount(s);
                        return { suit: s, len, honorCount };
                    })
                    .filter(o => o.len >= 5 || (o.len === 4 && o.honorCount >= 2))
                    .sort((a, b) => b.len - a.len || b.honorCount - a.honorCount);
                establishSuit = estCandidates.length ? estCandidates[0].suit : null;
                try {
                    // Opening plan (NT focus): lock a primary source of tricks after first trick; keep it sticky for tempo
                    if (isNTContract && !playState.establishPlanSuit && establishSuit) {
                        playState.establishPlanSuit = establishSuit;
                    }
                } catch (_) { }
            }

            // Endplay-style throw-in: when we have a tenace (e.g., AQx missing K) and a truly worthless exit suit, throw the opps in late to force a return
            if (ourSide && throwInSuits) {
                const tenaceSuits = ['S', 'H', 'D', 'C'].filter(s => {
                    const ranks = new Set(cardsInSuit(s, currentHands?.[seat]).concat(cardsInSuit(s, currentHands?.[partner])).map(c => c[0]));
                    return ranks.has('A') && ranks.has('Q') && !ranks.has('K');
                });
                const exitSuit = ['S', 'H', 'D', 'C']
                    .map(s => {
                        const cards = legalPlays.filter(c => c.endsWith(s));
                        if (!cards.length) return null;
                        const honorCount = cards.filter(c => ['A', 'K', 'Q', 'J', 'T'].includes(c[0])).length;
                        return { suit: s, cards, honorCount };
                    })
                    .filter(Boolean)
                    .filter(o => o.honorCount === 0 && !tenaceSuits.includes(o.suit));
                const nearEnd = handCount <= 6;
                if (tenaceSuits.length && exitSuit.length) {
                    const pickExit = exitSuit.find(o => (throwInSuits[o.suit] || 0) < 1 && o.cards.length);
                    const oppTrumpsGone = (!trump || oppTrumpLeft === 0 || oppTrumpLeft === null);
                    const haveEntryAfter = legalPlays.some(c => ['A', 'K', 'Q', 'J'].includes(c[0]));
                    if (pickExit && (nearEnd || oppTrumpsGone) && haveEntryAfter) {
                        try { throwInSuits[pickExit.suit] = (throwInSuits[pickExit.suit] || 0) + 1; } catch (_) { }
                        return sortAsc(pickExit.cards)[0];
                    }
                }
            }

            // Late-stage squeeze pressure: cash top winners from longest honor suit when trumps are drawn or in NT
            if (ourSide) {
                const late = handCount <= 5;
                const trumpsGone = (!trump || oppTrumpLeft === 0 || oppTrumpLeft === null);
                if (late && trumpsGone) {
                    const squeezeSuit = ['S', 'H', 'D', 'C']
                        .map(s => {
                            const cards = legalPlays.filter(c => c.endsWith(s));
                            if (!cards.length) return null;
                            const honorCount = cards.filter(c => ['A', 'K', 'Q', 'J', 'T'].includes(c[0])).length;
                            return { suit: s, cards, honorCount };
                        })
                        .filter(Boolean)
                        .filter(o => o.honorCount > 0)
                        .sort((a, b) => b.honorCount - a.honorCount || b.cards.length - a.cards.length || rankIndex(sortDesc(a.cards)[0]) - rankIndex(sortDesc(b.cards)[0]));
                    const pick = squeezeSuit[0];
                    if (pick) {
                        const desc = sortDesc(pick.cards);
                        let topSequenceCard = null;
                        for (let i = 0; i < desc.length - 1; i++) {
                            if (rankIndex(desc[i]) - rankIndex(desc[i + 1]) === 1) { topSequenceCard = desc[i]; break; }
                        }
                        return topSequenceCard || desc[0];
                    }
                }
            }

            const finesseLead = chooseFinesseLead();
            if (finesseLead) return finesseLead;
            const suitChoices = ['S', 'H', 'D', 'C']
                .map(s => {
                    const cards = legalPlays.filter(c => c.endsWith(s));
                    if (!cards.length) return null;
                    const honorCount = cards.filter(c => ['A', 'K', 'Q', 'J', 'T'].includes(c[0])).length;
                    const length = cards.length;
                    let score = length * 2 + honorCount;
                    const hasHighHonor = cards.some(c => ['A', 'K', 'Q'].includes(c[0]));
                    const hasHonor = honorCount > 0;
                    const loneOrShortHonor = hasHighHonor && length <= 3 && honorCount === 1;
                    const isNT = !trump;
                    if (trump && s === trump) {
                        // Declarer: draw trumps when holding honors and no clear ruff plan; otherwise save for ruffs/entries
                        if (ourSide) {
                            const wantToDraw = (oppTrumpLeft === null || oppTrumpLeft > 0) && trumpHonorCount >= 2 && !shortSuitRuffPotential;
                            if (wantToDraw) {
                                score += (combinedTrumpLen >= 4 ? 12 : 8);
                                if (entryCount >= 3) score += 2; // pull trump when we have entries to cash side suits
                            }
                            else score -= 4;
                        } else {
                            score -= (length >= 5 ? 0 : 6); // defense: generally avoid leading trump without length
                            if (length <= 3) score -= 12;   // strong penalty against short trump leads on defense
                        }
                    } else if (trump && ourSide && s !== trump) {
                        // Declarer: modest bonus for leading a long side suit when entries exist to establish it
                        if (length >= 5 && honorCount > 0 && entryCount >= 2) score += 2;
                    } else if (isNT) {
                        // NT: prefer longest/best suit; avoid leading from single honor; reward length >=4
                        const seqBonus = (() => {
                            const desc = cards.slice().sort((a, b) => rankIndex(b) - rankIndex(a));
                            for (let i = 0; i < desc.length - 1; i++) {
                                if (rankIndex(desc[i]) - rankIndex(desc[i + 1]) === 1) return 3; // touching honors
                            }
                            return 0;
                        })();
                        score += (length >= 4 ? 6 : 0) + (honorCount ? 2 : 0) + seqBonus;
                        if (loneOrShortHonor) score -= 4;
                        // NT-specific honor safety: heavier penalty for isolated honors on short length
                        if (loneOrShortHonor && length <= 3) score -= 3;
                        // Declarer: favor longest suit for establishment; Defense: also longest, but avoid ace-empty
                        const hasAceOnly = cards.some(c => c[0] === 'A') && honorCount === 1;
                        if (!ourSide && hasAceOnly) score -= 3;
                        // Declarer preference: combined length for establishment and entry count
                        if (ourSide) {
                            score += combinedLen(s);
                            if (entryCount >= 2 && length >= 4) score += 3; // Establish when we have entries to come back
                            if (hasAceOnly && playState?.ntPlanSuit && playState.ntPlanSuit !== s) score -= 5;
                        }
                        if (!ourSide) {
                            if (!hasHonor) score -= 3;
                            if (length >= 5 && hasHonor) score += 4;
                            if (length <= 2 && hasHonor) score -= 5;
                        }
                    }
                    // Suit contracts: bias declarer toward drawing trumps early unless a ruff is clearly indicated first.
                    if (!isNT && trump && s === trump && ourSide) {
                        const clearRuffNeed = shortSuitRuffPotential; // flagged when one side is short and the other long in a side suit
                        const wantToDraw = (oppTrumpLeft === null || oppTrumpLeft > 0) && trumpHonorCount >= 2 && !clearRuffNeed;
                        if (wantToDraw) {
                            score += (combinedTrumpLen >= 4 ? 16 : 12); // stronger pull toward drawing trump
                            if (entryCount >= 2) score += 3; // need entries to cash after pulling
                        } else {
                            // Keep trumps for ruffs/entries when a clear short-side ruff exists
                            score -= 10;
                        }
                    }
                    try {
                        if (isNT && ourSide && playState?.ntPlanSuit && playState.ntPlanSuit === s) score += 5;
                        if (isNT && ourSide && playState?.ntPlanSuit && playState.ntPlanSuit !== s && combinedLen(playState.ntPlanSuit) > combinedLen(s)) score -= 5;
                    } catch (_) { }
                    // Declarer: push hardest on chosen establishment suit
                    if (ourSide && establishSuit && establishSuit === s) score += 6;
                    // Use stored defensive signals: prefer partner-encouraged suit, avoid discouraged suit
                    if (!ourSide && defensePreferredSuit && defensePreferredSuit === s) score += 4;
                    if (!ourSide && defenseDiscourageSuit && defenseDiscourageSuit === s) score -= 3;
                    // Prefer partner's previous lead suit on defense
                    try {
                        if (!ourSide && playState?.lastLeadSuit && playState.lastLeadSuit === s && lastLeadFromOurSide) score += 5;
                    } catch (_) { }
                    // Avoid burning singleton/doubleton honors on defense and avoid cashing isolated honors into control
                    if (!ourSide && hasHighHonor && length <= 2) score -= 4;
                    if (!ourSide && loneOrShortHonor) score -= 3;
                    if (ourSide && loneOrShortHonor) score -= 5;
                    // Avoid leading from a lone honor unless we have length behind it
                    if (hasHighHonor && length <= 2) score -= 2;
                    // Tempo (NT focus): push harder on the stored plan suit; avoid depleted suits from partner's short holding
                    try {
                        if (isNTContract && ourSide && playState?.establishPlanSuit === s) score += 10;
                        if (isNTContract && ourSide && playState?.establishPlanSuit && s !== playState.establishPlanSuit) score -= 4;
                        if (isNTContract && ourSide && playState?.lastLeadSuit === s && lastLeadSeat === partner && length <= 1) score -= 4;
                    } catch (_) { }
                    return { suit: s, cards, score, length, honorCount };
                })
                .filter(Boolean)
                .sort((a, b) => b.score - a.score || b.length - a.length || b.honorCount - a.honorCount);

            const pick = suitChoices[0];
            if (pick) {
                const desc = sortDesc(pick.cards);
                // Lead top of an honor sequence when it exists; otherwise select by strain logic.
                let topSequenceCard = null;
                for (let i = 0; i < desc.length - 1; i++) {
                    if (rankIndex(desc[i]) - rankIndex(desc[i + 1]) === 1) {
                        topSequenceCard = desc[i];
                        break;
                    }
                }
                const isNT = isNTContract;
                // NT tempo: if we have a stored plan suit with cards available, honor it even if another suit barely outscores
                if (isNT && ourSide && playState?.establishPlanSuit && pick.suit !== playState.establishPlanSuit) {
                    const planSuit = playState.establishPlanSuit;
                    const planCards = legalPlays.filter(c => c.endsWith(planSuit));
                    if (planCards.length) {
                        const planDesc = planCards.slice().sort((a, b) => rankIndex(b) - rankIndex(a));
                        let planTopSeq = null;
                        for (let i = 0; i < planDesc.length - 1; i++) {
                            if (rankIndex(planDesc[i]) - rankIndex(planDesc[i + 1]) === 1) { planTopSeq = planDesc[i]; break; }
                        }
                        const planAsc = planCards.slice().sort((a, b) => rankIndex(a) - rankIndex(b));
                        if (planTopSeq) return planTopSeq;
                        const planIdx = Math.min(3, planAsc.length - 1);
                        return planAsc[planIdx];
                    }
                }
                const trumpLeadAsDeclarer = ourSide && trump && pick.suit === trump && (oppTrumpLeft === null || oppTrumpLeft > 0);
                if (isNT && ourSide && (!playState.ntPlanSuit || !legalPlays.some(c => c.endsWith(playState.ntPlanSuit)))) {
                    try { playState.ntPlanSuit = pick.suit; } catch (_) { }
                }
                if (trumpLeadAsDeclarer) {
                    // When drawing trump as declarer, take them cleanly with the highest available or top of sequence
                    return topSequenceCard || desc[0];
                }
                // Ace safety: avoid underleading bare/isolated ace when we own the length; keep the lead
                const aceGuard = pick.cards.find(c => c[0] === 'A');
                const hasK = pick.cards.some(c => c[0] === 'K');
                if (ourSide && aceGuard && !hasK && pick.length >= 3 && combinedLen(pick.suit) >= 4 && !topSequenceCard) {
                    return aceGuard;
                }
                if (isNT) {
                    // NT leads: Declarer sticks to plan/length; defense favors 4th-best from length+honor
                    if (topSequenceCard) return topSequenceCard;
                    const asc = sortAsc(pick.cards);
                    if (!ourSide) {
                        if (pick.length >= 4 && pick.honorCount > 0) {
                            const idx = Math.min(3, asc.length - 1);
                            return asc[idx];
                        }
                        return asc[0];
                    }
                    const idx = Math.min(3, asc.length - 1);
                    return idx >= 0 ? asc[idx] : asc[0];
                }
                // Suit contracts: on defense, lead 4th-best from length when possible to give count/attitude
                // Suit contracts: on defense, lead 4th-best from length when possible to give count/attitude
                if (!ourSide && trump && pick.suit !== trump && pick.length >= 4) {
                    const asc = sortAsc(pick.cards);
                    const idx = Math.min(3, asc.length - 1);
                    return asc[idx];
                }
                return topSequenceCard || sortAsc(pick.cards)[0];
            }
        }

        if (hasLeadSuit) {
            const leadPlays = legalPlays.filter(c => c.endsWith(leadSuit));
            const leadIsHonor = lead ? rankIndex(lead.code) >= rankIndex('J') : false;
            const winningOptions = trickTargetSuit ? winningCards(leadPlays) : [];
            // If an opponent is already winning this suit with an ace and we cannot beat it, give a signal with a spot (attitude/count) instead of burning honors.
            try {
                const current = playState?.trick && playState.trick.length ? computeTrickWinner(playState.trick, playState.trump) : null;
                const winnerSeat = current && current.seat ? current.seat : current;
                const winnerOnOurSide = current ? sameSide(winnerSeat) === ourSide : false;
                const winnerSuit = current ? (current.code || '').slice(-1) : null;
                const winnerIsAce = current ? (current.code || '')[0] === 'A' : false;
                if (!winnerOnOurSide && winnerSuit === leadSuit && winnerIsAce && !winningOptions.length) {
                    const honors = new Set(['A', 'K', 'Q', 'J', 'T']);
                    const spots = leadPlays.filter(c => !honors.has(c[0]));
                    const lowestSpot = pickLowestSpot(leadPlays) || sortAsc(leadPlays)[0];
                    if (!spots.length) return lowestSpot; // no spot available, fall back
                    const suitLen = leadPlays.length;
                    const hasKingOrQueen = leadPlays.some(c => c[0] === 'K' || c[0] === 'Q');
                    // Attitude: if we have K/Q behind the ace, encourage with a high spot; else default to lowest.
                    if (!ourSide && hasKingOrQueen) {
                        const highSpot = spots.sort((a, b) => rankIndex(b) - rankIndex(a))[0];
                        return highSpot || lowestSpot;
                    }
                    // Count: if no honor to show, use simple high-even/low-odd spot count
                    if (!ourSide && spots.length >= 2) {
                        const highSpot = spots.sort((a, b) => rankIndex(b) - rankIndex(a))[0];
                        const lowSpot = spots.sort((a, b) => rankIndex(a) - rankIndex(b))[0];
                        return (suitLen % 2 === 0) ? highSpot : lowSpot;
                    }
                    return lowestSpot;
                }
            } catch (_) { }
            // If partner is already winning the trick in this suit, conserve honors and play the cheapest card that follows suit.
            try {
                const current = playState?.trick && playState.trick.length ? computeTrickWinner(playState.trick, playState.trump) : null;
                const winnerSeat = current && current.seat ? current.seat : current;
                const winnerOnOurSide = current ? sameSide(winnerSeat) === ourSide : false;
                const winnerSuit = current ? (current.code || '').slice(-1) : null;
                if (winnerOnOurSide && winnerSuit === leadSuit && (!winningOptions.length || winnerSeat === partner)) {
                    const partnerLedLow = winnerSeat === partner && !leadIsHonor;
                    const winningHonor = winningOptions.find(c => ['A', 'K', 'Q', 'J'].includes(c[0]));
                    if (partnerLedLow && winningHonor) {
                        return winningOptions.sort((a, b) => rankIndex(a) - rankIndex(b))[0];
                    }
                    return pickLowestSpot(leadPlays) || sortAsc(leadPlays)[0];
                }
            } catch (_) { }
            if (leaderSideMatches && ourSide && finessePlan && finessePlan.suit === leadSuit && finessePlan.honorSeat === seat) {
                const targetCard = leadPlays.find(c => c[0] === finessePlan.target);
                if (targetCard) return targetCard;
                const altHonor = leadPlays.find(c => ['A', 'K', 'Q', 'J'].includes(c[0]));
                if (altHonor) return altHonor;
            }
            // If we have an NT plan suit and can follow it instead of auto-following lead (when not required), bias to stay on plan
            try {
                if (!leadSuit && playState?.ntPlanSuit && ourSide) {
                    const planPlays = legalPlays.filter(c => c.endsWith(playState.ntPlanSuit));
                    if (planPlays.length) return sortAsc(planPlays)[0];
                }
            } catch (_) { }
            // Defensive attitude signal when partner led: high encourage, low discourage (if not winning)
            if (leaderSideMatches && !ourSide && !winningOptions.length) {
                const honors = new Set(['A', 'K', 'Q', 'J', 'T']);
                const hasHonorInSuit = leadPlays.some(c => ['A', 'K', 'Q'].includes(c[0]));
                const encourage = hasHonorInSuit || leadPlays.length >= 4;
                const asc = sortAsc(leadPlays);
                const desc = sortDesc(leadPlays);
                const highestSpot = (() => {
                    const spots = leadPlays.filter(c => !honors.has(c[0]));
                    if (!spots.length) return null;
                    return spots.sort((a, b) => rankIndex(b) - rankIndex(a))[0];
                })();
                const lowestSpot = pickLowestSpot(leadPlays);
                const trumpSuit = (() => {
                    if (playState?.trump) return playState.trump;
                    const strain = playState?.contract && playState.contract.strain;
                    if (strain && strain !== 'NT') return strain;
                    return null;
                })();
                const trickHasOppTrump = (() => {
                    if (!trumpSuit) return false;
                    return (playState?.trick || []).some(t => t.code.endsWith(trumpSuit) && !sameSide(t.seat));
                })();
                const current = playState?.trick && playState.trick.length ? computeTrickWinner(playState.trick, playState.trump) : null;
                const currentSeat = current && current.seat ? current.seat : current;
                const oppWinning = current ? sameSide(currentSeat) !== ourSide : false;
                try {
                    if (encourage) { playState.defensePreferredSuit = leadSuit; playState.defenseDiscourageSuit = null; }
                    else { playState.defenseDiscourageSuit = leadSuit; }
                } catch (_) { }
                // If the trick has already been ruffed by an opponent, conserve honors and sluff small.
                if (trickHasOppTrump) return lowestSpot || asc[0];
                // If an opponent is currently winning with a higher card we cannot beat, encourage with a high spot (not an honor).
                if (oppWinning) {
                    if (encourage) return highestSpot || desc[0];
                    return lowestSpot || asc[0];
                }
                // Normal attitude: high (prefer spot) to encourage, low to discourage.
                return encourage ? (highestSpot || desc[0]) : (lowestSpot || asc[0]);
            }
            if (!trump && ourSide && !leaderSideMatches && trickTargetSuit === leadSuit) {
                const hasAce = leadPlays.some(c => c[0] === 'A');
                if (hasAce && leadPlays.length >= 2 && holdUpSuits) {
                    const used = holdUpSuits[leadSuit] || 0;
                    if (used < 1) {
                        try { holdUpSuits[leadSuit] = used + 1; } catch (_) { }
                        return sortAsc(leadPlays)[0];
                    }
                }
            }
            if (!leaderSideMatches && leadIsHonor && trickTargetSuit === leadSuit) {
                // Opponent led an honor in NT or side suit: cover only with touching/next honor; otherwise play low
                const touching = leadPlays.filter(c => rankIndex(c) === rankIndex(lead.code) + 1);
                if (touching.length) return touching.sort((a, b) => rankIndex(a) - rankIndex(b))[0];
                const higher = winningOptions.filter(c => rankIndex(c) <= rankIndex(lead.code) + 2);
                if (higher.length) return higher.sort((a, b) => rankIndex(a) - rankIndex(b))[0];
                return sortAsc(leadPlays)[0];
            }
            if (trump && leadSuit === trump && ourSide) {
                // When drawing trump as declarer, prefer to take the trick decisively rather than finessing low
                return winningOptions.length
                    ? winningOptions.sort((a, b) => rankIndex(b) - rankIndex(a))[0]
                    : sortDesc(leadPlays)[0];
            }
            if (leaderSideMatches && leadIsHonor) {
                // Partner led an honor; only overtake when an opponent is currently winning and we can win cheaply
                const opponentCurrentlyWinning = (() => {
                    const oppPlays = (playState?.trick || []).filter(t => !sameSide(t.seat));
                    return oppPlays.some(t => rankIndex(t.code) > rankIndex(lead.code));
                })();
                const partnerCurrentlyWinning = (() => {
                    const current = playState?.trick && playState.trick.length
                        ? computeTrickWinner(playState.trick, playState.trump)
                        : null;
                    const winnerSeat = current && current.seat ? current.seat : current;
                    return current ? sameSide(winnerSeat) === ourSide && winnerSeat === lead.seat : false;
                })();
                const cheapestWin = winningOptions.length
                    ? winningOptions.sort((a, b) => rankIndex(a) - rankIndex(b))[0]
                    : null;
                if (!ourSide) {
                    if (partnerCurrentlyWinning && !opponentCurrentlyWinning) {
                        const underTake = leadPlays.filter(c => rankIndex(c) <= rankIndex(lead.code));
                        if (underTake.length) return sortAsc(underTake)[0];
                        return sortAsc(leadPlays)[0];
                    }
                    if (opponentCurrentlyWinning) return cheapestWin || sortAsc(leadPlays)[0];
                    return cheapestWin || sortAsc(leadPlays)[0];
                }
                if (partnerCurrentlyWinning && !opponentCurrentlyWinning) return sortAsc(leadPlays)[0];
                return cheapestWin || sortAsc(leadPlays)[0];
            }
            if (leaderSideMatches && !leadIsHonor) {
                // Partner led low; play third hand high if we can win
                if (winningOptions.length) return winningOptions.sort((a, b) => rankIndex(b) - rankIndex(a))[0];
                const current = playState?.trick && playState.trick.length ? computeTrickWinner(playState.trick, playState.trump) : null;
                const winnerSeat = current && current.seat ? current.seat : current;
                const oppWinning = current ? sameSide(winnerSeat) !== ourSide : false;
                if (oppWinning) return pickLowestSpot(leadPlays);
                return sortAsc(leadPlays)[0];
            }
            // Opponent led: cover only if we can win cheaply; otherwise play low and conserve intermediates
            if (winningOptions.length) return winningOptions.sort((a, b) => rankIndex(a) - rankIndex(b))[0];
            const current = playState?.trick && playState.trick.length ? computeTrickWinner(playState.trick, playState.trump) : null;
            const winnerSeat = current && current.seat ? current.seat : current;
            const oppWinning = current ? sameSide(winnerSeat) !== ourSide : false;
            if (oppWinning) return pickLowestSpot(leadPlays);
            return sortAsc(leadPlays)[0];
        }

        // Cannot follow suit: prefer discard if partner is already winning; otherwise ruff low
        const trumpSuit = (() => {
            if (playState?.trump) return playState.trump;
            const strain = playState?.contract && playState.contract.strain;
            if (strain && strain !== 'NT') return strain;
            return null;
        })();
        const trumpCards = trumpSuit ? legalPlays.filter(c => c.endsWith(trumpSuit)) : [];
        const currentLeader = (playState?.trick && playState.trick.length)
            ? computeTrickWinner(playState.trick, playState.trump)
            : null;
        const leaderSeat = currentLeader && currentLeader.seat ? currentLeader.seat : currentLeader;
        const leaderOnOurSide = leaderSeat ? sameSide(leaderSeat) : false;
        const oppCurrentlyWinning = leaderSeat ? sameSide(leaderSeat) !== ourSide : true;
        const nonTrumpCount = legalPlays.length - trumpCards.length;
        const preferRuff = trumpSuit && trumpCards.length && (!leaderOnOurSide || nonTrumpCount <= 1);
        const partnerHasPlayed = (playState?.trick || []).some(t => t.seat === partner);
        const highestLeadRank = leadSuit ? Math.max(-1, ...((playState?.trick || []).filter(t => t.code.endsWith(leadSuit)).map(t => rankIndex(t.code)))) : -1;
        const partnerLeadOptions = leadSuit ? ((currentHands?.[partner]?.suitBuckets?.[leadSuit] || []).map(c => c.rank + leadSuit)) : [];
        const partnerBestLead = partnerLeadOptions.length ? Math.max(...partnerLeadOptions.map(rankIndex)) : -1;
        const partnerCanOvertake = (!partnerHasPlayed) && leadSuit && partnerBestLead > highestLeadRank;

        // No trumps to ruff and we are discarding on defense: prefer to keep honors, pitch lowest spot from safest suit.
        if (!trumpSuit || !trumpCards.length) {
            if (!leaderOnOurSide && oppCurrentlyWinning) {
                const honors = new Set(['A', 'K', 'Q', 'J', 'T']);
                const discardables = legalPlays
                    .map(c => ({ c, honor: honors.has(c[0]) }))
                    .filter(o => !o.honor);
                if (discardables.length) return sortAsc(discardables.map(o => o.c))[0];
                // If only honors remain, keep highest controls and shed the lowest honor
                return sortAsc(legalPlays)[0];
            }
        }

        // If opponents are currently winning the trick and we have trumps, ruff now with the cheapest winning trump (or any trump if none win).
        if (trumpSuit && trumpCards.length && oppCurrentlyWinning) {
            // If partner is still to play and can likely win the lead suit, conserve trump and discard instead.
            if (partnerCanOvertake) {
                const pitch = legalPlays.filter(c => !c.endsWith(trumpSuit));
                if (pitch.length) return sortAsc(pitch)[0];
                // If all remaining cards are trump, keep the smallest one.
                return sortAsc(trumpCards)[0];
            }
            const highestTrump = Math.max(-1, ...((playState?.trick || [])
                .filter(t => t.code.endsWith(trumpSuit))
                .map(t => rankIndex(t.code))));
            const winningTrumps = trumpCards.filter(c => rankIndex(c) > highestTrump);
            if (winningTrumps.length) return sortAsc(winningTrumps)[0];
            return sortAsc(trumpCards)[0];
        }

        // If we are short outside trumps, ruff immediately with the lowest winning trump
        if (trumpSuit && trumpCards.length && nonTrumpCount <= 1) {
            const highestTrump = Math.max(-1, ...((playState?.trick || [])
                .filter(t => t.code.endsWith(trumpSuit))
                .map(t => rankIndex(t.code))));
            const winningTrumps = trumpCards.filter(c => rankIndex(c) > highestTrump);
            if (winningTrumps.length) return sortAsc(winningTrumps)[0];
            return sortAsc(trumpCards)[0];
        }

        if (preferRuff) {
            const highestTrump = Math.max(-1, ...((playState?.trick || [])
                .filter(t => t.code.endsWith(trumpSuit))
                .map(t => rankIndex(t.code))));
            const winningTrumps = trumpCards.filter(c => rankIndex(c) > highestTrump);
            if (winningTrumps.length) {
                return sortAsc(winningTrumps)[0];
            }
            const pitch = legalPlays.filter(c => !c.endsWith(trumpSuit));
            if (pitch.length) return sortAsc(pitch)[0];
            return sortAsc(trumpCards)[0];
        }
        if (leaderOnOurSide) {
            const discards = trumpSuit ? legalPlays.filter(c => !c.endsWith(trumpSuit)) : legalPlays.slice();
            if (discards.length) {
                if (ourSide) {
                    // Declarer side: preserve winners; shed lowest available card
                    return sortAsc(discards)[0];
                }
                // Defense: suit-preference discard, but conserve honors—pitch lowest from the longest side suit
                const suits = ['S', 'H', 'D', 'C'].filter(s => s !== trumpSuit);
                let bestSuit = null;
                let bestLen = -1;
                for (const s of suits) {
                    const len = discards.filter(c => c.endsWith(s)).length;
                    if (len > bestLen) { bestLen = len; bestSuit = s; }
                }
                const suitCards = bestSuit ? discards.filter(c => c.endsWith(bestSuit)) : [];
                try { if (bestSuit) playState.defensePreferredSuit = bestSuit; } catch (_) { }
                if (suitCards.length) return sortAsc(suitCards)[0];
                return sortAsc(discards)[0];
            }
        }
        if (trumpCards.length) {
            const highestTrump = Math.max(-1, ...((playState?.trick || [])
                .filter(t => t.code.endsWith(trumpSuit))
                .map(t => rankIndex(t.code))));
            const winningTrumps = trumpCards.filter(c => rankIndex(c) > highestTrump);
            if (winningTrumps.length) {
                // Preserve entries: ruff low if possible, keep higher trumps for control
                return sortAsc(winningTrumps)[0];
            }
            const pitch = legalPlays.filter(c => !c.endsWith(trumpSuit));
            if (pitch.length) return sortAsc(pitch)[0];
            return sortAsc(trumpCards)[0];
        }
        return sortAsc(legalPlays)[0];
    };

    const cardToPlay = selectCardToPlay();
    removeCodeFromHand(hand, cardToPlay);
    return cardToPlay;
}

function playCardToTrick(seat, code) {
    // Safety: do not allow the same seat to place multiple cards in one trick
    try {
        if (playState && Array.isArray(playState.trick) && playState.trick.some(t => t.seat === seat)) {
            return;
        }
    } catch (_) { }
    // Log play event and current hands for diagnostics
    try {
        // If tests set `window.currentHands` or `window.playState`, use those so test fixtures are respected
        try { if (typeof window !== 'undefined' && window.currentHands) currentHands = window.currentHands; } catch (_) { }
        try { if (typeof window !== 'undefined' && window.playState) playState = window.playState; } catch (_) { }
        const summarizeHands = () => {
            const out = {};
            ['N', 'E', 'S', 'W'].forEach(s => {
                const h = currentHands?.[s];
                if (!h || !h.suitBuckets) { out[s] = []; return; }
                const list = [];
                ['S', 'H', 'D', 'C'].forEach(su => {
                    (h.suitBuckets[su] || []).forEach(c => list.push(c.rank + su));
                });
                out[s] = list;
            });
            return out;
        };
        const entry = `[BEFORE] ${new Date().toISOString()} seat=${seat} code=${code} next=${playState.nextSeat} trick=${JSON.stringify((playState.trick || []).slice())} remaining=${JSON.stringify(playState.remainingCounts || null)} hands=${JSON.stringify(summarizeHands())}`;
        // play log removed
        try { playLog.push(entry); } catch (_) { }
    } catch (_) { }

    // Record
    playState.trick.push({ seat, code });
    playState.played.add(code);
    try {
        if (playState.trick.length === 1) {
            playState.lastLeadSuit = code.slice(-1);
            playState.lastLeadSeat = seat;
        }
    } catch (_) { }
    // Show in trick area
    const area = document.getElementById('trickArea');
    if (area) {
        // Remove hint on first card
        const hint = area.querySelector('.trick-hint');
        if (hint) hint.remove();
        // Render trick-card at reduced size so multiple played cards remain visible
        // For trick-area cards: remove corner suit glyphs and show suit in center
        const el = (window.CardSVG && window.CardSVG.render) ? window.CardSVG.render(code, { width: 60, height: 85, noCornerSuit: true, centerAsSuit: true }) : null;
        if (el) {
            const wrap = document.createElement('div');
            wrap.className = 'trick-card';
            const label = document.createElement('div');
            label.className = 'trick-seat';
            label.textContent = seatName(seat);
            wrap.appendChild(el);
            wrap.appendChild(label);
            // Place into the appropriate slot if available
            const slot = area.querySelector(`.trick-slot[data-seat="${seat}"]`);
            // Prepare entry animation: start slightly scaled down and animate up
            let baseTranslate = '';
            if (slot && slot.classList.contains('trick-slot-north')) baseTranslate = 'translateY(12%)';
            else if (slot && slot.classList.contains('trick-slot-south')) baseTranslate = 'translateY(-12%)';
            else if (slot && slot.classList.contains('trick-slot-east')) baseTranslate = 'translateX(-12%)';
            else if (slot && slot.classList.contains('trick-slot-west')) baseTranslate = 'translateX(12%)';
            try {
                // Start slightly smaller and fade in (subtle animation)
                wrap.style.transform = (baseTranslate ? baseTranslate + ' ' : '') + 'scale(0.85)';
                wrap.style.opacity = '0';
            } catch (_) { }
            if (slot) {
                slot.appendChild(wrap);
            } else {
                // Fallback: append into area
                area.appendChild(wrap);
            }
            // Trigger transition to full size
            setTimeout(() => {
                try { wrap.style.transform = (baseTranslate ? baseTranslate + ' ' : '') + 'scale(1)'; wrap.style.opacity = '1'; } catch (_) { }
            }, 20);
        }
    }
    // Remove the card from the underlying hand state for automated plays
    try {
        try { removeCodeFromHand(currentHands?.[seat], code); } catch (_) { }
        // If the hand is currently rendered (e.g., dummy revealed), re-render it so the UI no longer shows the played card
        try {
            const containerIdMap = { N: 'playNorthHand', E: 'playEastHand', S: 'playSouthHand', W: 'playWestHand' };
            const cid = containerIdMap[seat];
            const el = cid ? document.getElementById(cid) : null;
            if (el && el.childElementCount > 0) {
                const clickable = (seat === 'N' || seat === 'S');
                try { renderPlayHand(cid, seat, clickable); } catch (_) { }
            }
        } catch (_) { }
    } catch (_) { }
    // If this is the first card of the hand (or of the trick), reveal dummy if not revealed yet
    if (!playState.dummyRevealed && playState.trick.length === 1 && playState.dummy) {
        revealDummy();
    }
    // Update remaining counts after a card is played
    try { computeRemainingCounts(); } catch (_) { }
    // Log post-play snapshot so we can trace play sequence
    try {
        const summarizeHands = () => {
            const out = {};
            ['N', 'E', 'S', 'W'].forEach(s => {
                const h = currentHands?.[s];
                if (!h || !h.suitBuckets) { out[s] = []; return; }
                const list = [];
                ['S', 'H', 'D', 'C'].forEach(su => {
                    (h.suitBuckets[su] || []).forEach(c => list.push(c.rank + su));
                });
                out[s] = list;
            });
            return out;
        };
        const entry = `[AFTER] ${new Date().toISOString()} seat=${seat} code=${code} trick=${JSON.stringify(playState.trick.slice())} next=${playState.nextSeat} remaining=${JSON.stringify(playState.remainingCounts || null)} hands=${JSON.stringify(summarizeHands())}`;
        // play log removed
        try { playLog.push(entry); } catch (_) { }
    } catch (_) { }
    // If trick complete, evaluate winner and set up next trick
    if (playState.trick.length === 4) {
        // compute winner and then pause; user must click to continue to next trick
        setTimeout(() => finishTrick(), 200);
    }
}

/**
 * Compute simple remaining counts for each seat and store into playState.remainingCounts
 * Format: { N: {S:2,H:3,D:1,C:7}, E: {...}, S: {...}, W: {...} }
 */
function computeRemainingCounts() {
    const suits = ['S', 'H', 'D', 'C'];
    const counts = { N: {}, E: {}, S: {}, W: {} };
    for (const seat of ['N', 'E', 'S', 'W']) {
        const hand = currentHands?.[seat];
        for (const s of suits) counts[seat][s] = (hand?.suitBuckets?.[s]?.length) || 0;
    }
    playState.remainingCounts = counts;
    // Also compute opponents combined counts helper
    playState.opponentsCombined = {};
    for (const s of suits) {
        const east = counts['E'][s] || 0;
        const west = counts['W'][s] || 0;
        playState.opponentsCombined[s] = east + west;
    }
    // Compute simple entries: number of non-trump suits with at least one card
    try {
        const trump = playState.trump || null;
        playState.entries = { N: 0, E: 0, S: 0, W: 0 };
        for (const seat of ['N', 'E', 'S', 'W']) {
            let c = 0;
            for (const s of suits) {
                if (s === trump) continue;
                if ((counts[seat][s] || 0) > 0) c++;
            }
            playState.entries[seat] = c;
        }
    } catch (_) { playState.entries = null; }
    // Compute dummy entry needs (number of side-suit entry points dummy likely requires to cash winners)
    try {
        const dummy = playState.dummy;
        let need = 0;
        if (dummy && currentHands?.[dummy]) {
            const trump = playState.trump || null;
            const honors = ['A', 'K', 'Q'];
            for (const s of suits) {
                if (s === trump) continue;
                const arr = currentHands[dummy]?.suitBuckets?.[s] || [];
                if (arr.length > 0 && arr.some(c => honors.includes(c.rank))) need++;
            }
        }
        playState.dummyEntryNeeds = Math.min(2, need);
    } catch (_) { playState.dummyEntryNeeds = 0; }
}

/**
 * Download the collected play log as a text file.
 */
function downloadPlayLog() {
    try {
        const header = 'Play log generated by PT Bridge Engine\n';
        const body = (Array.isArray(playLog) ? playLog.join('\n') : String(playLog));
        const blob = new Blob([header, '\n', body], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `play-log-${ts}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { } }, 2000);
    } catch (e) {
        console.warn('downloadPlayLog failed', e);
    }
}

/**
 * Download the auction history as a text file for review.
 */
function downloadAuctionLog() {
    try {
        // Prefer the captured console output for the Auction tab if available
        const lines = [];
        lines.push('Auction log generated by PT Bridge Engine');
        lines.push('');
        if (Array.isArray(auctionConsoleLog) && auctionConsoleLog.length > 0) {
            lines.push('--- Console output (Auction tab) ---');
            lines.push(...auctionConsoleLog);
            lines.push('');
        }

        if (!Array.isArray(auctionHistory) || auctionHistory.length === 0) {
            lines.push('[no auction entries recorded in auctionHistory]');
        } else {
            lines.push('--- Auction history entries ---');
            auctionHistory.forEach((entry, idx) => {
                try {
                    const pos = entry.position || entry.seat || '??';
                    const bid = entry.bid || {};
                    const token = bid && bid.token ? bid.token : (bid && bid.isDouble ? 'X' : (bid && bid.isRedouble ? 'XX' : (bid === null ? 'PASS' : String(bid))));
                    const seat = bid && bid.seat ? bid.seat : '';
                    const conv = (bid && bid.conventionUsed) ? bid.conventionUsed : (entry.explanation || '');
                    lines.push(`${idx + 1}. pos=${pos}${seat ? ' seat=' + seat : ''} token=${token} ${conv ? ' // ' + conv : ''}`);
                } catch (e) {
                    lines.push(`${idx + 1}. [unserializable entry] ${String(entry)}`);
                }
            });
        }

        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        a.download = `auction-log-${ts}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { } }, 2000);
    } catch (e) {
        console.warn('downloadAuctionLog failed', e);
    }
}

function finishTrick() {
    try {
        const winner = computeTrickWinner(playState.trick, playState.trump);
        const winnerSeat = winner && winner.seat ? winner.seat : winner;
        // Next leader is winner
        playState.leader = winnerSeat;
        playState.nextSeat = winnerSeat;
        // Increment trick counts
        if (['N', 'S'].includes(winnerSeat)) playState.tricksNS += 1; else playState.tricksEW += 1;
        updateTrickCountsUI();
        // Leave the played cards visible in their slots and prompt user to continue
        playState.trick = [];
        playState.awaitingContinue = true;
        const area = document.getElementById('trickArea');
        if (area) {
            // Remove any previous hint and show click-to-continue hint
            const prev = area.querySelector('.trick-hint');
            if (prev) prev.remove();
            const hint = document.createElement('div');
            hint.className = 'trick-hint';
            // Keep the hint concise; indicate click-to-continue only.
            hint.textContent = 'Click table to continue';
            area.appendChild(hint);
            // We no longer apply the lead highlight here. The highlight is applied
            // after the user continues (and initially when the play view renders)
            // so that it reflects the active lead for the upcoming trick.
            // Ensure click advances the trick only while awaitingContinue
            const handler = function onceHandler(evt) {
                try {
                    if (!playState.awaitingContinue) return;
                    continueAfterTrick();
                } catch (_) { }
            };
            // Use a delegated listener that checks the awaiting flag
            area.addEventListener('click', handler, { once: true });
        }
        // If all tricks completed, compute result after user continues; otherwise wait for click
        if (playState.tricksNS + playState.tricksEW >= 13) {
            // We'll call summarizeResult after the user clicks to acknowledge final trick
        }
    } catch (e) {
        console.warn('finishTrick failed:', e?.message || e);
    }
}

function continueAfterTrick() {
    try {
        playState.awaitingContinue = false;
        // Clear trick area completely to avoid stray cards (e.g., if a seat lacked a slot)
        // then rebuild the four seat slots and the hint.
        const area = document.getElementById('trickArea');
        if (area) {
            try { area.innerHTML = ''; } catch (_) { }
            ['N', 'E', 'S', 'W'].forEach(s => {
                const slot = document.createElement('div');
                slot.className = `trick-slot trick-slot-${s === 'N' ? 'north' : s === 'S' ? 'south' : s === 'E' ? 'east' : 'west'}`;
                slot.dataset.seat = s;
                area.appendChild(slot);
            });
            const hint = document.createElement('div');
            hint.className = 'trick-hint';
            hint.textContent = 'Click a card to play';
            area.appendChild(hint);
        }
        // Update the lead highlight for the upcoming trick: remove any existing
        // highlight and then add it to the current leader/nextSeat so the UI
        // reflects who is on lead once the player has continued.
        try {
            document.querySelectorAll('.hand-title.lead').forEach(el => el.classList.remove('lead'));
        } catch (_) { }
        // If all tricks completed, finalize result
        if (playState.tricksNS + playState.tricksEW >= 13) {
            summarizeResult();
            return;
        }
        // Ensure next to play is leader and resume automated play if needed
        playState.nextSeat = playState.leader;
        try {
            // Apply the lead highlight to the updated nextSeat
            if (typeof updateLeadHighlight === 'function') updateLeadHighlight();
        } catch (_) { }
        setTimeout(() => autoPlayIfNeeded(), 200);
    } catch (e) { console.warn('continueAfterTrick failed:', e?.message || e); }
}

// Update the UI highlight for the current lead. Adds the `.lead` class to the
// relevant `.hand-title` element based on `playState.nextSeat` or `playState.leader`.
function updateLeadHighlight() {
    try {
        const seat = (playState && playState.nextSeat) ? playState.nextSeat : (playState && playState.leader) ? playState.leader : null;
        if (!seat) return;
        // Clear any existing
        document.querySelectorAll('.hand-title.lead').forEach(el => el.classList.remove('lead'));
        const sideMap = { N: 'north', S: 'south', E: 'east', W: 'west' };
        const cls = sideMap[seat] ? `.play-seat-${sideMap[seat]} .hand-title` : null;
        if (cls) {
            const el = document.querySelector(cls);
            if (el) el.classList.add('lead');
        }
    } catch (_) { }
}

function computeTrickWinner(trick, trump) {
    // trick: [{ seat, code }]; trump: 'S'|'H'|'D'|'C'|null
    if (!trick || trick.length === 0) return null;
    const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
    const leadSuit = trick[0].code.slice(-1);
    // Gather trump cards
    const trumps = trump ? trick.filter(c => c.code.slice(-1) === trump) : [];
    let pool = trumps.length ? trumps : trick.filter(c => c.code.slice(-1) === leadSuit);
    // Highest rank wins in the pool
    let best = pool[0];
    for (const c of pool) {
        const r1 = rankOrder.indexOf(best.code[0]);
        const r2 = rankOrder.indexOf(c.code[0]);
        if (r2 > r1) best = c;
    }
    return best;
}

function removeCodeFromHand(hand, code) {
    const suit = code.slice(-1);
    const rank = code.slice(0, -1);
    const arr = hand?.suitBuckets?.[suit];
    if (!arr) return;
    const idx = arr.findIndex(c => c.rank === rank);
    if (idx >= 0) arr.splice(idx, 1);
}

function partnerOf(seat) { return seat === 'N' ? 'S' : seat === 'S' ? 'N' : seat === 'E' ? 'W' : 'E'; }
function leftOf(seat) { return seat === 'N' ? 'E' : seat === 'E' ? 'S' : seat === 'S' ? 'W' : 'N'; }
function seatName(seat) { return ({ N: 'North', E: 'East', S: 'South', W: 'West' }[seat] || seat); }

function revealDummy() {
    if (playState.dummyRevealed) return;
    const dummy = playState.dummy;
    if (!dummy) return;
    try {
        const containerMap = {
            N: 'playNorthHand',
            E: 'playEastHand',
            S: 'playSouthHand',
            W: 'playWestHand'
        };
        const cid = containerMap[dummy];
        if (cid && currentHands?.[dummy]) {
            const row = document.getElementById(cid);
            if (row) {
                row.innerHTML = '';
                // Let the user play dummy when our side declared; opponents' dummy stays locked.
                const dummyClickable = playState && playState.contractSide === 'NS';
                renderPlayHand(cid, dummy, dummyClickable);
            }
        }
        playState.dummyRevealed = true;
    } catch (_) { }
}

function canPlayCode(seat, code) {
    const hand = currentHands?.[seat];
    if (!hand) return false;
    const leadSuit = playState.trick.length ? playState.trick[0].code.slice(-1) : null;
    if (!leadSuit) return true; // leading the trick
    const suit = code.slice(-1);
    if (suit === leadSuit) return true;
    // Check if player holds any of lead suit
    const hasLead = (hand.suitBuckets?.[leadSuit] || []).length > 0;
    return !hasLead;
}

function updateTrickCountsUI() {
    try { document.getElementById('trickCountNS').textContent = String(playState.tricksNS); } catch (_) { }
    try { document.getElementById('trickCountEW').textContent = String(playState.tricksEW); } catch (_) { }
}

function showPlayStatus(message, kind = 'light') {
    const el = document.getElementById('playStatus');
    if (!el) return;
    el.textContent = message;
    el.className = `alert alert-${kind}`;
    el.style.display = 'block';
    // Auto-fade non-error messages
    if (kind !== 'danger') {
        setTimeout(() => { try { el.style.display = 'none'; } catch (_) { } }, 1800);
    }
}

// Debugging output disabled in cleaned state: keep a no-op so call sites
// remain valid but do not produce UI overlay noise. Re-enable as needed.
function appendPlayDebug(msg) { /* no-op */ }

function summarizeResult() {
    const contract = playState.contract;
    const declarer = playState.declarer;
    const side = playState.contractSide; // 'NS' or 'EW'
    if (!contract || !declarer || !side) return;
    const tricksDecl = (side === 'NS') ? playState.tricksNS : playState.tricksEW;
    const result = computeDuplicateScore(contract, side, tricksDecl, vulnerabilityForSide(side));
    const total = result.total;
    // Update inline score for N/S on the trick-counts line. We show the score from N/S perspective.
    try {
        const scoreEl = document.getElementById('playInlineScore');
        if (scoreEl) {
            // result.total is score for the declarer side. Convert to N/S perspective.
            const nsScore = (side === 'NS') ? total : -total;
            scoreEl.textContent = (nsScore >= 0 ? '+' + nsScore : String(nsScore));
        }
    } catch (_) { }

    // Reveal all hands now that the play is complete.
    try {
        // Remove any trick hint from the table area so the green area no longer prompts play.
        const area = document.getElementById('trickArea');
        if (area) {
            const prev = area.querySelector('.trick-hint'); if (prev) prev.remove();
        }
        // Render all hands visibly (non-interactive)
        try {
            const containers = { N: 'playNorthHand', E: 'playEastHand', S: 'playSouthHand', W: 'playWestHand' };
            ['N', 'E', 'S', 'W'].forEach(seat => {
                try {
                    const cid = containers[seat];
                    const el = document.getElementById(cid);
                    if (el) el.innerHTML = '';
                    // Use renderHandCards so all seats' full cards are shown (not backs)
                    renderHandCards(cid, seat);
                    // Disable any interactive handlers on rendered buttons
                    const buttons = Array.from(document.querySelectorAll('#' + cid + ' .card-button'));
                    buttons.forEach(b => {
                        try { b.disabled = true; b.classList.add('non-clickable'); if (typeof onCardClick === 'function') b.removeEventListener('click', onCardClick); } catch (_) { }
                    });
                } catch (_) { }
            });
        } catch (_) { }
    } catch (_) { }
}

function vulnerabilityForSide(side) {
    // vulnerability.ns/ew reflect NS/EW vulnerability
    return side === 'NS' ? !!vulnerability.ns : !!vulnerability.ew;
}

function computeDuplicateScore(contract, side, tricksWon, vul) {
    // Return score for declarer side (positive if made, negative if down)
    const level = contract.level;
    const strain = contract.strain; // 'C','D','H','S','NT'
    const required = 6 + level;
    const over = tricksWon - required;
    const isMajor = (strain === 'H' || strain === 'S');
    const isMinor = (strain === 'C' || strain === 'D');
    const dbl = contract.dbl || 0; // 0/1/2
    const multiplier = dbl === 0 ? 1 : (dbl === 1 ? 2 : 4);

    const trickValue = strain === 'NT' ? 30 : isMajor ? 30 : 20;
    const firstNTBonus = strain === 'NT' ? 10 : 0;

    const breakdown = { trickPoints: 0, insult: 0, gameBonus: 0, partScoreBonus: 0, slamBonus: 0, overtricks: 0, penalties: 0 };

    if (over < 0) {
        // Undertricks penalties (non-vs-vul simple version; doubles not modeled here)
        const u = -over;
        if (dbl === 0) {
            breakdown.penalties = (vul ? 100 : 50) * u;
            return { total: -breakdown.penalties, breakdown };
        }
        // Doubled/redoubled undertricks
        const first = vul ? 200 : 100;
        const secondThird = vul ? 300 : 200;
        const subsequent = 300; // both vul and non-vul
        let pen = 0;
        if (u >= 1) pen += first;
        if (u >= 2) pen += secondThird;
        if (u >= 3) pen += secondThird;
        if (u >= 4) pen += subsequent * (u - 3);
        if (dbl === 2) pen *= 2; // redoubled
        breakdown.penalties = pen;
        return { total: -pen, breakdown };
    }

    // Contract made: compute trick points
    let baseTrickPoints = (strain === 'NT' ? (firstNTBonus + trickValue * level) : (trickValue * level));
    let trickPoints = baseTrickPoints * multiplier;
    let score = trickPoints;
    breakdown.trickPoints = trickPoints;
    // Insult bonus for doubled/redoubled
    if (dbl === 1) { score += 50; breakdown.insult = 50; }
    if (dbl === 2) { score += 100; breakdown.insult = 100; }
    // Game or part-score bonus (based on trick points after doubling)
    if (trickPoints >= 100) {
        const gb = vul ? 500 : 300;
        score += gb; breakdown.gameBonus = gb;
    } else {
        score += 50; breakdown.partScoreBonus = 50;
    }
    // Overtricks
    if (over > 0) {
        if (dbl === 0) {
            const val = over * (strain === 'NT' ? 30 : isMajor ? 30 : 20);
            score += val; breakdown.overtricks = val;
        } else if (dbl === 1) {
            const val = over * (vul ? 200 : 100);
            score += val; breakdown.overtricks = val;
        } else {
            const val = over * (vul ? 400 : 200);
            score += val; breakdown.overtricks = val;
        }
    }
    // Slam bonuses
    if (level === 6) { const b = vul ? 750 : 500; score += b; breakdown.slamBonus = b; }
    if (level === 7) { const b = vul ? 1500 : 1000; score += b; breakdown.slamBonus = b; }
    return { total: score, breakdown };
}

// Controls: Undo and Clear Trick
document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'playReplayBtn') {
        replayHand();
    } else if (e.target && e.target.id === 'playNewDealBtn') {
        newDealFromPlay();
    }
});

// Claim, Replay, New Deal
/* Removed: promptClaim() - claiming via button removed. Claiming can still be simulated in tests
   by directly adjusting `playState.tricksNS` / `playState.tricksEW` and calling
   `updateTrickCountsUI()` followed by `summarizeResult()` if needed. */

function replayHand() {
    try {
        if (!playState.originalHands) return;
        // Deep clone original hands back into currentHands
        currentHands = cloneHands(playState.originalHands);
        try { if (typeof window !== 'undefined') window.currentHands = currentHands; } catch (_) { }
        // Reset play state and re-render Play tab
        renderPlayTab();
        showPlayStatus('Replaying hand from the start.', 'light');
    } catch (e) { console.warn('replayHand failed:', e?.message || e); }
}

function newDealFromPlay() {
    try {
        const proceed = window.confirm('Start a new deal? Current play will be discarded.');
        if (!proceed) return;
        // Generate a new random deal and move to Auction tab to bid anew
        generateRandomHands();
        switchTab('auction');
    } catch (e) { console.warn('newDealFromPlay failed:', e?.message || e); }
}

function cloneHands(source) {
    const out = { N: null, E: null, S: null, W: null };
    ['N', 'E', 'S', 'W'].forEach(seat => {
        const h = source[seat];
        if (!h) return;
        out[seat] = cloneHand(h);
    });
    return out;
}

function cloneHand(hand) {
    const suits = ['S', 'H', 'D', 'C'];
    const buckets = {};
    suits.forEach(s => {
        buckets[s] = (hand.suitBuckets?.[s] || []).map(c => new window.Card(c.rank, s));
    });
    return new window.Hand(buckets);
}

// Expose functions used by inline onclick handlers in index.html so they are available with module scripts
try {
    if (typeof window !== 'undefined') {
        Object.assign(window, {
            switchTab,
            setGenerationMode,
            generateRandomHands,
            generateFromManualHands,
            generateConstrainedHands,
            toggleOtherHands,
            getRecommendedBid,
            startAuction,
            resetAuction,
            makeBid
        });
    }
} catch (_) { /* ignore in non-browser contexts */ }

// Expose guard helpers for tests (CommonJS-friendly via jest strip loader)
try {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports.applyResponderMajorGuard = applyResponderMajorGuard;
        module.exports.applyOvercallLengthGuard = applyOvercallLengthGuard;
        module.exports.applyTwoLevelFreeBidGuard = applyTwoLevelFreeBidGuard;
        // Test helpers for practice focus generation
        module.exports.generateConventionTargetedHand = generateConventionTargetedHand;
        module.exports.validateDealForConvention = validateDealForConvention;
        module.exports.currentHands = currentHands;
    }
} catch (_) { /* non-fatal */ }
