/**
 * /shared/blocks.js
 * Defines the landing-page block types and renders them safely.
 *
 * Security note, since this is the one part of the whole project where
 * admin-authored TEXT reaches a page every anonymous visitor loads: every
 * block is built with textContent / setAttribute, never innerHTML with
 * interpolated admin content. There is no "custom HTML" block type — by
 * design, admins compose pages from structured fields (a heading, a body
 * paragraph, a button link), not raw markup. Links and image URLs are
 * passed through safeUrl() to reject `javascript:`-style URIs.
 *
 * Used by:
 *  - index.html: renderLayout(blocks, container) — the real, live rendering
 *  - admin.html: same TYPES definitions drive the editor's field forms and
 *    the block-list summaries, so the editor can never drift out of sync
 *    with what actually renders
 */
(function (global) {

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.setAttribute('style', v);
      else node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (c === undefined || c === null || c === '') return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Only allow schemes that can't execute script (blocks javascript:, data:
  // for links, vbscript:, etc.). Empty/missing stays empty rather than
  // defaulting to something that could surprise the admin.
  function safeUrl(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(trimmed)) return trimmed;
    return '';
  }

  const TYPES = {
    hero: {
      label: 'Hero Banner',
      fields: [
        { key: 'eyebrow', label: 'Eyebrow Text', type: 'text', placeholder: 'Welcome' },
        { key: 'heading', label: 'Heading', type: 'text', required: true, placeholder: 'Your Home, Simplified.' },
        { key: 'subtext', label: 'Subtext', type: 'textarea', placeholder: 'A short supporting line under the heading.' },
        { key: 'ctaText', label: 'Button Text', type: 'text', placeholder: 'View Properties' },
        { key: 'ctaLink', label: 'Button Link', type: 'url', placeholder: '#properties' },
      ],
      summary: p => p.heading || '(no heading yet)',
      render(props) {
        const children = [];
        if (props.eyebrow) children.push(el('p', { class: 'block-hero-eyebrow', style: 'font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:var(--amber);margin-bottom:16px;' }, props.eyebrow));
        children.push(el('h2', { style: "font-size:clamp(2.4rem,5vw,4rem);font-weight:400;line-height:1.15;margin-bottom:18px;font-family:var(--font-heading,'Cormorant Garamond',serif);" }, props.heading || ''));
        if (props.subtext) children.push(el('p', { style: 'font-size:16px;color:var(--slate);max-width:480px;margin:0 auto 28px;line-height:1.7;' }, props.subtext));
        const link = safeUrl(props.ctaLink);
        if (props.ctaText && link) {
          children.push(el('a', { href: link, class: 'btn-primary', style: 'display:inline-block;padding:14px 32px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;border-radius:2px;' }, props.ctaText));
        }
        return el('section', { style: 'text-align:center;padding:60px 24px;' }, children);
      },
    },
    richtext: {
      label: 'Text Block',
      fields: [
        { key: 'heading', label: 'Heading (optional)', type: 'text' },
        { key: 'body', label: 'Body Text', type: 'textarea', required: true },
      ],
      summary: p => p.heading || (p.body ? p.body.slice(0, 40) + '…' : '(empty)'),
      render(props) {
        const children = [];
        if (props.heading) children.push(el('h3', { style: "font-size:1.8rem;font-weight:500;margin-bottom:12px;font-family:var(--font-heading,'Cormorant Garamond',serif);" }, props.heading));
        // Preserve line breaks the admin typed, without ever using innerHTML —
        // each line becomes its own <p>, still built with textContent.
        (props.body || '').split('\n').filter(Boolean).forEach(line => {
          children.push(el('p', { style: 'font-size:15px;color:var(--slate);line-height:1.7;margin-bottom:10px;' }, line));
        });
        return el('section', { style: 'max-width:640px;margin:0 auto;padding:40px 24px;' }, children);
      },
    },
    image: {
      label: 'Image',
      fields: [
        { key: 'imageUrl', label: 'Image URL', type: 'url', required: true },
        { key: 'caption', label: 'Caption (optional)', type: 'text' },
        { key: 'alt', label: 'Alt Text (for accessibility)', type: 'text' },
      ],
      summary: p => p.caption || p.imageUrl || '(no image yet)',
      render(props) {
        const src = safeUrl(props.imageUrl);
        const children = [];
        if (src) children.push(el('img', { src, alt: props.alt || '', style: 'max-width:100%;border-radius:4px;display:block;margin:0 auto;' }));
        if (props.caption) children.push(el('p', { style: 'font-size:13px;color:var(--slate);text-align:center;margin-top:10px;' }, props.caption));
        return el('section', { style: 'max-width:800px;margin:0 auto;padding:32px 24px;' }, children);
      },
    },
    cta: {
      label: 'Call to Action',
      fields: [
        { key: 'heading', label: 'Heading', type: 'text', required: true },
        { key: 'buttonText', label: 'Button Text', type: 'text', required: true },
        { key: 'buttonLink', label: 'Button Link', type: 'url', required: true },
      ],
      summary: p => p.heading || '(no heading yet)',
      render(props) {
        const children = [el('h3', { style: "font-size:1.6rem;font-weight:500;margin-bottom:18px;font-family:var(--font-heading,'Cormorant Garamond',serif);" }, props.heading || '')];
        const link = safeUrl(props.buttonLink);
        if (props.buttonText && link) {
          children.push(el('a', { href: link, class: 'btn-primary', style: 'display:inline-block;padding:14px 32px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;border-radius:2px;' }, props.buttonText));
        }
        return el('section', { style: 'text-align:center;padding:48px 24px;background:var(--cream,#F7F4EF);' }, children);
      },
    },
    propertyGrid: {
      label: 'Property Listings',
      fields: [], // no editable props — this always shows the live, real listings
      summary: () => 'Live property listings (auto-updates, not editable here)',
      // Rendered specially by index.html itself (it needs Firestore + the
      // existing country-filtering logic) — this just reserves the spot in
      // the layout order. admin.html's editor shows it as a placeholder card.
      render() {
        return el('div', { 'data-block-placeholder': 'propertyGrid', style: 'padding:20px;text-align:center;color:var(--slate);font-size:13px;border:1px dashed var(--border);border-radius:4px;margin:24px;' }, 'Property listings render here on the live site.');
      },
    },
    spacer: {
      label: 'Spacer',
      fields: [
        { key: 'size', label: 'Size', type: 'select', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], required: true },
      ],
      summary: p => `Spacer (${p.size || 'medium'})`,
      render(props) {
        const heights = { small: '24px', medium: '56px', large: '110px' };
        return el('div', { style: `height:${heights[props.size] || heights.medium};` });
      },
    },
  };

  function renderBlock(block) {
    const def = TYPES[block.type];
    if (!def) return el('div', {}, ''); // unknown block type — render nothing rather than throw
    try { return def.render(block.props || {}); }
    catch (err) { console.error('Block render failed:', block.type, err); return el('div', {}, ''); }
  }

  function renderLayout(blocks, container) {
    container.innerHTML = '';
    (blocks || []).forEach(b => container.appendChild(renderBlock(b)));
  }

  global.PageBlocks = { TYPES, renderBlock, renderLayout, safeUrl, el };
})(window);
