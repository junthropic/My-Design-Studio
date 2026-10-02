import type { Project, WebPage, WebSection, Dataset } from '../core/types.ts';
import { resolveDesign } from '../core/design.ts';

export const htmlEscape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const jsonScript = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
const cssColor = (value: unknown, fallback: string) =>
  /^#[\da-f]{3,8}$/i.test(String(value)) ? String(value) : fallback;
const safeId = (value: string) => encodeURIComponent(value).replace(/'/g, '%27');
export function webAssetName(project: Project, id: string) {
  const asset = project.assets.find((a) => a.id === id);
  const extension = asset?.relativePath.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '';
  return safeId(id) + extension;
}
function assetURL(project: Project, id: string, base: string) {
  return base + (base.startsWith('/api/') ? safeId(id) : webAssetName(project, id));
}
function webFontCSS(project: Project, assetBase: string) {
  const base = assetBase.startsWith('/api/') ? '/fonts/' : 'fonts/';
  const formats: Record<string, string> = {
    'font/ttf': 'truetype',
    'font/otf': 'opentype',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
  };
  const uploaded = project.assets
    .filter((a) => formats[a.mime])
    .map((a) => {
      const family =
        a.name
          .split(/[\\/]/)
          .pop()!
          .replace(/\.[^.]*$/, '')
          .normalize('NFKC')
          .replace(/[^\p{L}\p{N} _-]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100) || `StudioFont-${a.hash.slice(0, 12)}`;
      return `@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(assetURL(project, a.id, assetBase))}) format(${JSON.stringify(formats[a.mime])});font-display:swap;font-style:normal;font-weight:100 900;}`;
    })
    .join('');
  return (
    `@font-face{font-family:'Pretendard';src:url('${base}PretendardVariable.woff2') format('woff2');font-display:swap;font-style:normal;font-weight:100 900;}` +
    uploaded
  );
}
function formatted(value: unknown, type?: string) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' && !value.trim()) return value;
  if (type === 'date') {
    const date =
      typeof value === 'number'
        ? new Date(value)
        : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)
          ? new Date(value)
          : null;
    return date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('ko-KR', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          timeZone: 'UTC',
        }).format(date)
      : String(value);
  }
  const n = Number(value);
  if (type === 'percent' && Number.isFinite(n))
    return new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 }).format(n);
  if (type === 'currency' && Number.isFinite(n))
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency',
      currency: 'KRW',
      maximumFractionDigits: 0,
    }).format(n);
  if (type === 'number' && Number.isFinite(n))
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(n);
  return String(value);
}
function dataFor(project: Project, section: WebSection): Dataset | undefined {
  return project.datasets.find((d) => d.id === section.dataId) || project.datasets[0];
}
function tableMarkup(project: Project, section: WebSection) {
  const d = dataFor(project, section);
  if (!d) return '<p class="empty">연결된 데이터가 없습니다.</p>';
  if (!d.columns.length) return '<p class="empty">데이터 열이 없습니다.</p>';
  if (!d.rows.length) return '<p class="empty">표시할 데이터 행이 없습니다.</p>';
  return `<div class="table-tools"><label>행 검색 <input type="search" data-table-filter placeholder="검색어 입력"></label><span class="row-count" aria-live="polite">${d.rows.length}개 행</span></div><div class="table-scroll"><table><caption>${htmlEscape(d.name)} · ${htmlEscape(d.updatedAt)}</caption><thead><tr>${d.columns.map((c, i) => `<th scope="col" aria-sort="none"><button type="button" data-sort="${i}">${htmlEscape(c)} <span aria-hidden="true">↕</span></button></th>`).join('')}<th scope="col">상세</th></tr></thead><tbody>${d.rows.map((r, i) => `<tr data-row-index="${i}">${d.columns.map((c) => `<td data-value="${htmlEscape(r[c])}" class="${typeof r[c] === 'number' ? 'number' : ''}">${htmlEscape(formatted(r[c], d.formats?.[c]))}</td>`).join('')}<td><button class="subtle" type="button" data-row-detail>열기</button></td></tr>`).join('')}</tbody></table></div>`;
}
function chartMarkup(project: Project, section: WebSection) {
  const d = dataFor(project, section);
  if (!d) return '<p class="empty">연결된 데이터가 없습니다.</p>';
  if (!d.rows.length) return '<p class="empty">차트에 표시할 데이터 행이 없습니다.</p>';
  const isNumber = (v: unknown) =>
    v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v));
  const numeric =
    d.columns.find(
      (c) =>
        ['number', 'percent', 'currency'].includes(d.formats?.[c] || '') &&
        d.rows.some((r) => isNumber(r[c])),
    ) || d.columns.find((c) => d.rows.some((r) => typeof r[c] === 'number'));
  if (!numeric) return '<p class="empty">숫자 열을 연결하면 차트를 표시합니다.</p>';
  const label = d.columns.find((c) => c !== numeric) || numeric;
  const all = d.rows.filter((r) => isNumber(r[numeric]));
  const rows = all.slice(0, 20);
  const values = rows.map((r) => Number(r[numeric]));
  const min = Math.min(0, ...values),
    max = Math.max(0, ...values),
    range = max - min || 1,
    zero = (-min / range) * 100;
  return `<div class="chart" role="img" aria-label="${htmlEscape(section.title)}"><p class="chart-label">${htmlEscape(numeric)}${all.length > 20 ? ' · 처음 20개 행' : ''}</p>${rows
    .map((r) => {
      const value = Number(r[numeric]);
      return `<div class="chart-row"><span>${htmlEscape(formatted(r[label], d.formats?.[label]))}</span><div class="chart-track" style="position:relative"><span style="position:absolute;left:${zero}%;height:100%;border-left:1px solid var(--muted)"></span><div style="position:absolute;left:${((Math.min(value, 0) - min) / range) * 100}%;width:${(Math.abs(value) / range) * 100}%;background:${value < 0 ? 'var(--danger)' : 'var(--accent)'}"></div></div><strong>${htmlEscape(formatted(r[numeric], d.formats?.[numeric]))}</strong></div>`;
    })
    .join(
      '',
    )}</div><details><summary>차트 데이터 보기</summary>${tableMarkup(project, section)}</details>`;
}
function sectionMarkup(
  project: Project,
  section: WebSection,
  assetBase: string,
  pageSections: WebSection[] = [],
) {
  const heading = `<h2>${htmlEscape(section.title)}</h2>${section.body ? `<p class="section-description">${htmlEscape(section.body)}</p>` : ''}`;
  const items = section.items || [];
  const linkedAsset = project.assets.find((a) => a.id === section.assetId);
  const image = linkedAsset?.mime.startsWith('image/')
    ? `<img class="section-image" src="${htmlEscape(assetURL(project, linkedAsset.id, assetBase))}" alt="${htmlEscape(linkedAsset.name || section.title)}" loading="lazy">`
    : '';
  let inner = '';
  switch (section.type) {
    case 'hero':
      inner = `<div class="hero-copy"><p class="eyebrow">${htmlEscape(project.brand.name)}</p><h1>${htmlEscape(section.title)}</h1><p class="lead">${htmlEscape(section.body)}</p><a class="button" href="#${htmlEscape(pageSections.find((s) => s.enabled && s.type === 'projects')?.id || pageSections.find((s) => s.enabled && s.type !== 'hero')?.id || 'content')}">내용 살펴보기 <span aria-hidden="true">↗</span></a></div>${image}`;
      break;
    case 'table':
      inner = heading + tableMarkup(project, section);
      break;
    case 'chart':
      inner = heading + chartMarkup(project, section);
      break;
    case 'faq':
      inner =
        heading +
        `<div class="faq">${items.map((item) => `<details><summary>${htmlEscape(item.title)}</summary><p>${htmlEscape(item.body)}</p></details>`).join('')}</div>`;
      break;
    case 'stats':
      inner =
        heading +
        `<div class="stats section-grid">${items.map((item) => `<article><strong>${htmlEscape(item.title)}</strong><p>${htmlEscape(item.body)}</p></article>`).join('')}</div>`;
      break;
    case 'projects':
      inner =
        heading +
        `<div class="project-tools"><label>사례 검색 <input data-project-filter type="search" placeholder="제목 또는 내용"></label></div><div class="section-grid projects">${items.map((item, i) => `<article class="project-card" data-project-card>${i === 0 ? image : ''}<span class="index">${String(i + 1).padStart(2, '0')}</span><h3>${htmlEscape(item.title)}</h3><p>${htmlEscape(item.body)}</p><button class="subtle" data-project-detail type="button">자세히 보기 ↗</button></article>`).join('')}</div><p class="project-empty empty" hidden>일치하는 사례가 없습니다.</p>`;
      break;
    case 'contact':
      inner =
        heading +
        `<div class="contact-links">${items
          .map((item) => {
            const url = item.body.trim();
            const href = /^(https?:\/\/|mailto:|tel:)/i.test(url) ? url : '';
            return href
              ? `<a class="button" href="${htmlEscape(href)}" ${href.startsWith('http') ? 'rel="noopener noreferrer" target="_blank"' : ''}>${htmlEscape(item.title)}</a>`
              : `<p><strong>${htmlEscape(item.title)}</strong> ${htmlEscape(item.body)}</p>`;
          })
          .join('')}</div>`;
      break;
    case 'about':
      inner =
        heading +
        image +
        `<div class="about-text">${items.map((item) => `<article><h3>${htmlEscape(item.title)}</h3><p>${htmlEscape(item.body)}</p></article>`).join('')}</div>`;
      break;
    default:
      inner =
        heading +
        `<div class="section-grid">${items.map((item) => `<article class="feature"><h3>${htmlEscape(item.title)}</h3><p>${htmlEscape(item.body)}</p></article>`).join('')}</div>`;
  }
  if (image && !inner.includes(image)) inner += image;
  return `<section id="${htmlEscape(section.id)}" class="section ${section.type} ${section.align === 'center' ? 'center' : ''}" style="--columns:${Math.min(6, Math.max(1, section.columns))};--mobile-columns:${Math.min(3, Math.max(1, section.mobileColumns || 1))};--section-padding:${Math.min(300, Math.max(0, section.padding ?? 64))}px">${inner}</section>`;
}

/** Literal source stays self-contained across Vite/tsx minification and helper injection. */
export const WEB_INTERACTIONS = String.raw`function mountWebInteractions(root=document){
 const dialog=root.querySelector('#detail-dialog');
 const show=(title,content)=>{if(!dialog)return;dialog.querySelector('h2').textContent=title;dialog.querySelector('.dialog-content').innerHTML=content;dialog.showModal();};
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 root.querySelector('[data-close-dialog]')?.addEventListener('click',()=>dialog?.close());dialog?.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
 root.querySelectorAll('.section').forEach(section=>{
  section.querySelectorAll('[data-table-filter]').forEach(input=>input.addEventListener('input',()=>{const scope=input.closest('.table-tools')?.nextElementSibling;let count=0;scope?.querySelectorAll('tbody tr').forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(input.value.toLowerCase());if(!row.hidden)count++;});const label=input.closest('.table-tools')?.querySelector('.row-count');if(label)label.textContent=count+'개 행';}));
  section.querySelectorAll('[data-sort]').forEach(button=>button.addEventListener('click',()=>{const table=button.closest('table'),index=Number(button.dataset.sort),th=button.closest('th'),direction=th.getAttribute('aria-sort')==='ascending'?-1:1;table.querySelectorAll('th').forEach(h=>h.setAttribute('aria-sort','none'));th.setAttribute('aria-sort',direction===1?'ascending':'descending');const body=table.tBodies[0];Array.from(body.rows).sort((a,b)=>{const av=a.cells[index].dataset.value||'',bv=b.cells[index].dataset.value||'';return direction*(av.trim()&&bv.trim()&&Number.isFinite(Number(av))&&Number.isFinite(Number(bv))?Number(av)-Number(bv):av.localeCompare(bv,'ko',{numeric:true}));}).forEach(row=>body.append(row));}));
  section.querySelectorAll('[data-row-detail]').forEach(button=>button.addEventListener('click',()=>{const row=button.closest('tr'),headers=Array.from(button.closest('table').querySelectorAll('thead th')).slice(0,-1);show('행 상세','<dl>'+headers.map((h,i)=>'<dt>'+esc(h.textContent.replace('↕','').trim())+'</dt><dd>'+esc(row.cells[i].textContent)+'</dd>').join('')+'</dl>');}));
  section.querySelector('[data-project-filter]')?.addEventListener('input',e=>{const value=e.target.value.toLowerCase();let visible=0;section.querySelectorAll('[data-project-card]').forEach(card=>{card.hidden=!card.textContent.toLowerCase().includes(value);if(!card.hidden)visible++;});const empty=section.querySelector('.project-empty');if(empty)empty.hidden=visible>0;});
  section.querySelectorAll('[data-project-detail]').forEach(button=>button.addEventListener('click',()=>{const card=button.closest('article');show(card.querySelector('h3')?.textContent||'사례','<p>'+esc(card.querySelector('p')?.textContent||'')+'</p>');}));
 });
 const links=root.querySelectorAll('[data-section-link]');links.forEach(link=>link.addEventListener('click',()=>links.forEach(a=>a.setAttribute('aria-current',a===link?'location':'false'))));
 const tabs=Array.from(root.querySelectorAll('[data-page-tab]'));
 const activate=button=>{tabs.forEach(b=>{b.setAttribute('aria-selected',String(b===button));b.tabIndex=b===button?0:-1;});root.querySelectorAll('[data-tab-panel]').forEach(panel=>panel.hidden=panel.dataset.tabPanel!==button.dataset.pageTab);};
 tabs.forEach((button,i)=>{button.tabIndex=i===0?0:-1;button.addEventListener('click',()=>activate(button));button.addEventListener('keydown',e=>{let n=i;if(e.key==='ArrowRight')n=(i+1)%tabs.length;else if(e.key==='ArrowLeft')n=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')n=0;else if(e.key==='End')n=tabs.length-1;else return;e.preventDefault();tabs[n].focus();activate(tabs[n]);});});
}`;

export function renderWebHTML(
  project: Project,
  pageId?: string,
  assetBase = '/api/assets/',
): string {
  const page: WebPage | undefined =
    project.webPages.find((p) => p.id === pageId) || project.webPages[0];
  if (!page)
    return '<!doctype html><html lang="ko"><meta charset="utf-8"><title>페이지 없음</title><body><p>웹 페이지를 추가하세요.</p></body></html>';
  const t = resolveDesign(project, 'web').tokens;
  const palette = {
    bg: cssColor(t['color.bg'], '#10141c'),
    surface: cssColor(t['color.surface'], '#1c2230'),
    text: cssColor(t['color.text'], '#f4f6fb'),
    muted: cssColor(t['color.muted'], '#9ca9c0'),
    accent: cssColor(t['color.accent'], project.brand.color),
    onAccent: cssColor(t['color.onAccent'], '#fff'),
    border: cssColor(t['color.border'], '#30394a'),
  };
  const font = String(t['font.family'] || project.brand.font || 'Malgun Gothic').replace(
    /[^\p{L}\p{N}\s,_-]/gu,
    '',
  );
  const radius = Number.isFinite(Number(t['radius.card']))
    ? Math.min(40, Math.max(0, Number(t['radius.card'])))
    : 12;
  const sections = page.sections.filter((s) => s.enabled);
  let css = `:root{color-scheme:${project.mode};--bg:${palette.bg};--surface:${palette.surface};--text:${palette.text};--muted:${palette.muted};--accent:${palette.accent};--on-accent:${palette.onAccent};--border:${palette.border};--radius:${radius}px}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:'${font}','Malgun Gothic',system-ui,sans-serif;font-size:${project.accessibility.largeText ? 19 : 16}px;line-height:1.65}a{color:inherit}button,input{font:inherit}button,a,input,summary{outline-offset:5px}:focus-visible{outline:3px solid var(--accent)}button{cursor:pointer}button:disabled{cursor:default}img{max-width:100%;display:block}[hidden]{display:none!important}.skip{position:absolute;left:16px;top:-100px;z-index:10}.skip:focus{top:12px}.site-header{padding:24px max(24px,calc((100vw - 1200px)/2));border-bottom:1px solid var(--border);display:flex;align-items:center;gap:32px;flex-wrap:wrap}.brand{font-weight:750;text-decoration:none;letter-spacing:-.035em}.site-header nav{display:flex;gap:24px;flex-wrap:wrap;margin-left:auto;font-size:.85rem}.site-header nav a{text-decoration:none;color:var(--muted)}.site-header nav a:hover,.site-header nav a[aria-current=location]{color:var(--text)}main{max-width:1200px;margin:auto;padding:0 32px}.section{padding:var(--section-padding) 0;border-bottom:1px solid var(--border)}.section.center{text-align:center}h1,h2,h3,p{margin:0}h1{font-size:clamp(2.8rem,7vw,5.5rem);line-height:1.08;letter-spacing:-.055em;max-width:900px;font-weight:750}h2{font-size:clamp(1.7rem,3vw,2.5rem);line-height:1.2;letter-spacing:-.04em;margin-bottom:18px}h3{font-size:1.2rem;line-height:1.4;margin-bottom:12px}.section-description,.lead{color:var(--muted);max-width:720px;white-space:pre-line}.lead{font-size:1.15rem;margin-top:28px;margin-bottom:32px}.hero{min-height:560px;display:flex;align-items:center;gap:48px}.hero-copy{flex:1}.hero .section-image{width:40%;max-height:520px;object-fit:cover}.eyebrow{color:var(--accent);font-size:.8rem;letter-spacing:.12em;margin-bottom:28px}.button{display:inline-flex;align-items:center;gap:36px;background:var(--accent);color:var(--on-accent);border:0;border-radius:6px;padding:12px 20px;text-decoration:none;font-weight:650}.section-grid{display:grid;grid-template-columns:repeat(var(--columns),minmax(0,1fr));gap:28px;margin-top:36px}.feature{padding:26px 0;border-top:2px solid var(--accent)}.feature p,.project-card p,.about-text p{color:var(--muted);white-space:pre-line}.project-card{min-width:0}.project-card .section-image{height:230px;object-fit:cover;border-radius:var(--radius);margin-bottom:20px}.index{font-size:.75rem;color:var(--accent);margin:12px 0;display:block}.subtle{background:transparent;color:var(--accent);border:0;padding:8px 0;text-align:left}.stats strong{font-size:clamp(2rem,5vw,4rem);font-weight:650;letter-spacing:-.05em}.stats p{color:var(--muted)}.table-tools,.project-tools{margin:28px 0 16px;display:flex;align-items:center;justify-content:space-between;gap:20px}.table-tools label,.project-tools label{display:flex;gap:12px;align-items:center}input{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 12px;color:var(--text);min-width:0}.row-count{color:var(--muted);font-size:.8rem}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.85rem;text-align:left}caption{text-align:left;color:var(--muted);margin:12px 0}th,td{padding:14px 16px;border-bottom:1px solid var(--border);white-space:nowrap}th{background:var(--surface)}th button{background:none;color:var(--text);border:0;padding:0;white-space:nowrap}td.number{text-align:right;font-variant-numeric:tabular-nums}tbody tr:hover{background:var(--surface)}.chart{margin:32px 0}.chart-label{font-size:.8rem;color:var(--muted);margin-bottom:20px}.chart-row{display:grid;grid-template-columns:minmax(70px,160px) 1fr 70px;gap:18px;align-items:center;margin:12px 0;font-size:.8rem}.chart-row strong{text-align:right}.chart-track{height:22px;background:var(--surface);overflow:hidden;border-radius:3px}.chart-track div{height:100%;background:var(--accent);min-width:1px}.faq{margin-top:32px}details{border-bottom:1px solid var(--border);padding:20px 0}summary{cursor:pointer;font-weight:600}details p{color:var(--muted);margin-top:18px;max-width:760px}.contact-links{display:flex;gap:20px;flex-wrap:wrap;margin-top:28px}.about-text{display:grid;grid-template-columns:repeat(var(--columns),1fr);gap:32px;margin-top:28px}.about .section-image{max-height:500px;object-fit:contain;margin-top:28px}.site-footer{max-width:1200px;margin:0 auto;padding:36px 32px;color:var(--muted);font-size:.8rem;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.page-links{display:flex;gap:16px;flex-wrap:wrap}.empty{color:var(--muted);padding:24px 0}dialog{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);width:min(640px,90vw);max-height:85vh;padding:32px}dialog::backdrop{background:#0009}.dialog-close{float:right;background:none;border:0;color:var(--text);font-size:24px}.dialog-content{margin-top:24px}.dialog-content dt{font-size:.8rem;color:var(--muted);margin-top:16px}.dialog-content dd{margin:4px 0;overflow-wrap:anywhere}.page-tabs{display:flex;gap:8px;margin-top:28px}.page-tabs button{padding:10px 18px;border:1px solid var(--border);background:var(--surface);color:var(--text)}.page-tabs button[aria-selected=true]{border-color:var(--accent);color:var(--accent)}@media(max-width:720px){main{padding:0 20px}.site-header{padding:20px}.site-header nav{gap:16px;margin-left:0}.hero{min-height:440px;flex-direction:column;align-items:stretch}.hero .section-image{width:100%;max-height:360px}.section{padding:40px 0}.section-grid,.about-text{grid-template-columns:repeat(var(--mobile-columns),minmax(0,1fr));gap:24px}.table-tools,.table-tools label,.project-tools label{align-items:stretch;flex-direction:column;gap:8px}.chart-row{grid-template-columns:80px 1fr 55px;gap:10px}.site-footer{padding:28px 20px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}${project.accessibility.reducedMotion ? 'html{scroll-behavior:auto}' : ''}`;
  css = webFontCSS(project, assetBase) + css;
  const numberToken = (key: string, min: number, max: number, fallback: number) => {
    const n = Number(t[key]);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  css += `:root{--danger:${cssColor(t['color.danger'], '#ff758c')}}body{font-size:${numberToken('font.body', 10, 40, 16)}px;line-height:${numberToken('font.lineHeight', 1, 3, 1.55)};letter-spacing:${numberToken('font.tracking', -2, 8, 0)}px}h1{font-size:clamp(2.4rem,7vw,${numberToken('font.title', 24, 160, 40) * 2}px)}h2{font-size:clamp(1.5rem,3vw,${numberToken('font.title', 24, 160, 40)}px)}.section-grid{gap:${numberToken('space.base', 8, 80, 24)}px}.site-header{backdrop-filter:blur(${numberToken('effect.blur', 0, 40, 0)}px)}.hero{background:radial-gradient(ellipse at 90% 10%,color-mix(in srgb,var(--accent) ${numberToken('effect.glow', 0, 1.4, 0) * numberToken('effect.decor', 0, 1.4, 1) * 12}%,transparent),transparent 65%)}.center .section-description,.center .lead{margin-left:auto;margin-right:auto}`;
  const dashboardTabs =
    page.kind === 'dashboard'
      ? `<div class="page-tabs" role="tablist" aria-label="데이터 보기"><button id="tab-all" type="button" role="tab" data-page-tab="all" aria-selected="true" aria-controls="panel-all">전체 현황</button><button id="tab-data" type="button" role="tab" data-page-tab="data" aria-selected="false" aria-controls="panel-data">데이터 중심</button></div>`
      : '';
  const content = sections.map((s) => sectionMarkup(project, s, assetBase, sections)).join('');
  const logoAsset = project.assets.find(
    (a) => a.id === project.brand.logoAssetId && a.mime.startsWith('image/'),
  );
  const brandLogo = logoAsset
    ? `<img class="brand-logo" src="${htmlEscape(assetURL(project, logoAsset.id, assetBase))}" alt="${htmlEscape(project.brand.name)} 로고">`
    : '';
  css +=
    '.brand{display:inline-flex;align-items:center;gap:12px}.brand-logo{width:60px;height:32px;object-fit:contain}.section-image{max-height:520px;object-fit:contain;margin-top:24px}';
  const body = `<a class="skip" href="#content">본문으로 이동</a><header class="site-header"><a class="brand" href="index.html">${brandLogo}${htmlEscape(project.brand.name)}</a><nav aria-label="페이지 섹션">${sections
    .filter((s) => s.type !== 'hero')
    .slice(0, 6)
    .map((s) => `<a data-section-link href="#${htmlEscape(s.id)}">${htmlEscape(s.title)}</a>`)
    .join('')}</nav></header><main id="content">${dashboardTabs}${
    page.kind === 'dashboard'
      ? `<div id="panel-all" role="tabpanel" aria-labelledby="tab-all" data-tab-panel="all">${content}</div><div id="panel-data" role="tabpanel" aria-labelledby="tab-data" data-tab-panel="data" hidden>${sections
          .filter((s) => ['table', 'chart'].includes(s.type))
          .map((s) => sectionMarkup(project, { ...s, id: s.id + '-data' }, assetBase))
          .join('')}</div>`
      : content
  }</main><footer class="site-footer"><span>${htmlEscape(project.brand.name)} · ${new Date(project.updatedAt).getUTCFullYear() || new Date().getUTCFullYear()}</span><nav class="page-links" aria-label="다른 페이지">${project.webPages.map((p, i) => `<a href="${i === 0 ? 'index.html' : 'page-' + safeId(p.id) + '.html'}" ${p.id === page.id ? 'aria-current="page"' : ''}>${htmlEscape(p.name)}</a>`).join('')}</nav></footer><dialog id="detail-dialog" aria-labelledby="detail-title"><button type="button" class="dialog-close" data-close-dialog aria-label="상세 닫기">×</button><h2 id="detail-title"></h2><div class="dialog-content"></div></dialog>`;
  const previewNav = assetBase.startsWith('/api/')
    ? `(()=>{const routes=${jsonScript(Object.fromEntries(project.webPages.map((p, i) => [i === 0 ? 'index.html' : `page-${safeId(p.id)}.html`, p.id])))};document.addEventListener('click',event=>{const a=event.target.closest('a');const href=a?.getAttribute('href');if(href&&Object.hasOwn(routes,href)){event.preventDefault();window.parent.postMessage({type:'design-studio:web-page',pageId:routes[href]},'*');}});})();`
    : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(page.title)}</title><meta name="description" content="${htmlEscape(page.description)}"><meta property="og:title" content="${htmlEscape(page.title)}"><meta property="og:description" content="${htmlEscape(page.description)}"><style>${css}</style></head><body>${body}<script type="application/json" id="design-data">${jsonScript(project.datasets.map(({ id, name, columns, rows, updatedAt, formats }) => ({ id, name, columns, rows, updatedAt, formats })))}</script><script>(${WEB_INTERACTIONS})(document);${previewNav}</script></body></html>`;
}
