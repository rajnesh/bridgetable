/*
 * Simple SVG playing card generator.
 * Provides CardSVG.createElement(rank, suit, opts) and CardSVG.render(code, opts).
 * rank: 'A','K','Q','J','T','9'..'2'
 * suit: 'S','H','D','C'
 */
(function(global){
  const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_COLOR = { S: '#111', C: '#111', H: '#C01818', D: '#C01818' };
  const RANK_LABEL = { T: '10' };

  function createElement(rank, suit, opts={}){
    const w = opts.width || 80;
    const h = opts.height || 120;
    const r = opts.radius || 8;
    const color = SUIT_COLOR[suit] || '#111';
    const label = (RANK_LABEL[rank] || rank);

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('class', `card-svg suit-${suit}`);

    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x','0'); bg.setAttribute('y','0');
    bg.setAttribute('rx', String(r)); bg.setAttribute('ry', String(r));
    bg.setAttribute('width', String(w)); bg.setAttribute('height', String(h));
    bg.setAttribute('fill', '#fff');
    bg.setAttribute('stroke', '#222');
    bg.setAttribute('stroke-width', '1');
    svg.appendChild(bg);

    // Corner rank + suit top-left
    const tl = document.createElementNS(svgNS, 'text');
    tl.setAttribute('x', '8'); tl.setAttribute('y', '18');
    tl.setAttribute('font-family', 'system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif');
    tl.setAttribute('font-size', '20');
    tl.setAttribute('font-weight', '700');
    tl.setAttribute('fill', color);
    tl.textContent = label;
    tl.setAttribute('class', 'corner-rank');
    svg.appendChild(tl);

    // Optionally suppress the small corner suit glyphs (used for trick-area compact cards)
    if (!opts.noCornerSuit) {
      const tl2 = document.createElementNS(svgNS, 'text');
      tl2.setAttribute('x', '8'); tl2.setAttribute('y', '36');
      tl2.setAttribute('font-family', 'system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif');
      tl2.setAttribute('font-size', '20');
      tl2.setAttribute('fill', color);
      tl2.textContent = SUIT_SYMBOL[suit] || '';
      tl2.setAttribute('class', 'corner-suit');
      svg.appendChild(tl2);
    }

    // Bottom-right rotated corner
    const br = document.createElementNS(svgNS, 'g');
    br.setAttribute('transform', `rotate(180 ${w/2} ${h/2}) translate(-${w}, -${h})`);
    const br1 = document.createElementNS(svgNS, 'text');
    br1.setAttribute('x', String(w-20)); br1.setAttribute('y', String(h-8-18));
    br1.setAttribute('font-family', 'system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif');
    br1.setAttribute('font-size', '20');
    br1.setAttribute('font-weight', '700');
    br1.setAttribute('fill', color);
    br1.textContent = label;
    br1.setAttribute('class', 'corner-rank');
    br.appendChild(br1);
    if (!opts.noCornerSuit) {
      const br2 = document.createElementNS(svgNS, 'text');
      br2.setAttribute('x', String(w-20)); br2.setAttribute('y', String(h-8));
      br2.setAttribute('font-family', 'system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif');
      br2.setAttribute('font-size', '20');
      br2.setAttribute('fill', color);
      br2.textContent = SUIT_SYMBOL[suit] || '';
      br2.setAttribute('class', 'corner-suit');
      br.appendChild(br2);
    }
    svg.appendChild(br);

    // Center pip or rank artwork
    const center = document.createElementNS(svgNS, 'text');
    center.setAttribute('x', String(w/2));
    center.setAttribute('y', String(h/2 + 14));
    center.setAttribute('font-family', 'system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif');
    // Allow callers to force the center to be the suit symbol instead of the rank
    if (opts.centerAsSuit) {
      center.setAttribute('font-size', (rank==='A' ? '64' : '56'));
    } else {
      center.setAttribute('font-size', (rank==='A' ? '64' : (rank==='K'||rank==='Q'||rank==='J' ? '56' : '44')));
    }
    center.setAttribute('text-anchor', 'middle');
    center.setAttribute('fill', color);
    // For 2..10 show big suit pip, for face/Ace show the rank letter
    if (opts.centerAsSuit) {
      center.textContent = SUIT_SYMBOL[suit] || '';
    } else {
      if (rank==='A' || rank==='K' || rank==='Q' || rank==='J') {
        center.textContent = rank;
      } else {
        center.textContent = SUIT_SYMBOL[suit] || '';
      }
    }
    center.setAttribute('class', 'center-rank');
    svg.appendChild(center);

    return svg;
  }

  function codeToRankSuit(code){
    if (!code || typeof code !== 'string') return null;
    const s = code.slice(-1).toUpperCase();
    let r = code.slice(0, -1).toUpperCase();
    if (r === '10') r = 'T';
    if (!['S','H','D','C'].includes(s)) return null;
    const ranks = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
    if (!ranks.includes(r)) return null;
    return { rank: r, suit: s };
  }

  function render(code, opts={}){
    const rs = codeToRankSuit(code);
    if (!rs) return null;
    return createElement(rs.rank, rs.suit, opts);
  }

  global.CardSVG = { createElement, codeToRankSuit, render };
})(typeof window !== 'undefined' ? window : globalThis);
