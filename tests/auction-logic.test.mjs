import test from 'node:test';
import assert from 'node:assert/strict';
import { applyResponderMajorGuard, applyOvercallLengthGuard, applyTwoLevelFreeBidGuard } from '../assets/js/auction-logic-guards.js';

const Bid = class {
    constructor(token) { this.token = token; }
};

const isValidSystemBid = () => true;
const isOpponentPosition = (pos, ours) => {
    const tag = (s) => (s === 'N' || s === 'S') ? 'NS' : 'EW';
    return tag(pos) !== tag(ours);
};

function makeHistory(entries) {
    return entries.map(e => ({ position: e.seat, bid: new Bid(e.token) }));
}

test('responder guard does not force repeat after prior contract bid', () => {
    const auctionHistory = makeHistory([
        { seat: 'S', token: '1C' },
        { seat: 'E', token: '1S' },
        { seat: 'W', token: 'PASS' }
    ]);
    const hand = { hcp: 10, lengths: { S: 5, H: 3, D: 3, C: 2 } };

    const { recommendedBid } = applyResponderMajorGuard({
        recommendedBid: { token: 'PASS' },
        explanation: '',
        forcedBid: false,
        currentTurn: 'E',
        auctionHistory,
        hand,
        isValidSystemBid,
        computeTotalPoints: () => 10
    });

    assert.equal(recommendedBid.token, 'PASS');
});

test('responder guard suggests 1S over partner 1C with 5 spades', () => {
    // Opener South bids 1C, West passes; North (partner) should respond with 1S holding 5 spades
    const auctionHistory = makeHistory([
        { seat: 'S', token: '1C' },
        { seat: 'W', token: 'PASS' }
    ]);
    const hand = { hcp: 9, lengths: { S: 5, H: 2, D: 3, C: 3 } };

    const { recommendedBid } = applyResponderMajorGuard({
        recommendedBid: { token: 'PASS' },
        explanation: '',
        forcedBid: false,
        currentTurn: 'N',
        auctionHistory,
        hand,
        isValidSystemBid,
        computeTotalPoints: () => 9
    });

    assert.equal(recommendedBid.token, '1S');
});

test('overcall length guard blocks 2C with only three clubs', () => {
    const auctionHistory = makeHistory([
        { seat: 'N', token: '1S' }
    ]);
    const hand = { hcp: 12, lengths: { C: 3, D: 3, H: 3, S: 4 } };

    const { recommendedBid, explanation } = applyOvercallLengthGuard({
        recommendedBid: { token: '2C' },
        explanation: '',
        forcedBid: false,
        currentTurn: 'E',
        auctionHistory,
        hand,
        isOpponentPosition
    });

    assert.equal(recommendedBid.token, 'PASS');
    assert.match(explanation, /5\+ cards/);
});

test('overcall length guard allows 2C with five clubs', () => {
    const auctionHistory = makeHistory([
        { seat: 'N', token: '1S' }
    ]);
    const hand = { hcp: 12, lengths: { C: 5, D: 3, H: 2, S: 3 } };

    const { recommendedBid } = applyOvercallLengthGuard({
        recommendedBid: { token: '2C' },
        explanation: '',
        forcedBid: false,
        currentTurn: 'E',
        auctionHistory,
        hand,
        isOpponentPosition
    });

    assert.equal(recommendedBid.token, '2C');
});

test('two-level new-suit after prior pass with low HCP downgrades to PASS', () => {
    // South opens 1C, West overcalls 1S, North has previously passed and holds only 5 HCP.
    const auctionHistory = makeHistory([
        { seat: 'S', token: '1C' },
        { seat: 'W', token: '1S' },
        { seat: 'N', token: 'PASS' }
    ]);
    const hand = { hcp: 5, lengths: { C: 2, D: 5, H: 3, S: 3 } };

    // Model/recommended tries to bid 2D; guard should downgrade to PASS.
    const { recommendedBid, explanation } = applyTwoLevelFreeBidGuard({
        recommendedBid: { token: '2D' },
        explanation: 'Test free bid',
        forcedBid: false,
        currentTurn: 'N',
        auctionHistory,
        hand
    });

    assert.equal(recommendedBid.token, 'PASS');
    assert.match(explanation, /Pass/);
});

test('two-level raise of partner suit allowed with 3-card support and 6+ HCP', () => {
    // Partner opens 1H, responder has 7 HCP and 3-card heart support; 2H raise should be allowed.
    const auctionHistory = makeHistory([
        { seat: 'S', token: '1H' }
    ]);
    const hand = { hcp: 7, lengths: { H: 3, S: 3, D: 3, C: 4 } };

    const { recommendedBid } = applyTwoLevelFreeBidGuard({
        recommendedBid: { token: '2H' },
        explanation: '',
        forcedBid: false,
        currentTurn: 'N',
        auctionHistory,
        hand
    });

    assert.equal(recommendedBid.token, '2H');
});
