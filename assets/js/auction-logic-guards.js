// Pure helpers for auction-logic guards. Imported by app.js and used by tests.

function partnerOf(seat) {
    const map = { N: 'S', S: 'N', E: 'W', W: 'E' };
    return map[seat] || null;
}

function sameSide(seatA, seatB) {
    const tag = (s) => (s === 'N' || s === 'S') ? 'NS' : 'EW';
    if (!seatA || !seatB) return false;
    return tag(seatA) === tag(seatB);
}

export function applyResponderMajorGuard({
    recommendedBid,
    explanation,
    forcedBid,
    currentTurn,
    auctionHistory,
    hand,
    isValidSystemBid,
    computeTotalPoints
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
    const totalPoints = (typeof computeTotalPoints === 'function') ? computeTotalPoints(hand) : hcp;
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

export function applyOvercallLengthGuard({
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

// Guard: avoid speculative two-level new-suit bids after a prior pass or with very low HCP (free bids)
export function applyTwoLevelFreeBidGuard({
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

export default {
    applyResponderMajorGuard,
    applyOvercallLengthGuard,
    applyTwoLevelFreeBidGuard
};
