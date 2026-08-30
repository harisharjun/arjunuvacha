"""Mirror of the JS extractPdfText()/assembleLines(): cluster words into visual
rows by baseline with a height-derived tolerance, then join by real horizontal
gap (touching runs concatenate, normal gap = space, wide gap = column break).
Feeds the real PDFs into the JS parser exactly as pdf.js would in the browser."""
import sys, json, glob, os, statistics
import pdfplumber

def assemble(words):
    if not words:
        return []
    heights = sorted(w['bottom'] - w['top'] for w in words)
    median_h = heights[len(heights) // 2] or 9
    tol = max(2.5, median_h * 0.55)

    ws = sorted(words, key=lambda w: (-w['top'], w['x0']), reverse=False)
    ws = sorted(words, key=lambda w: (w['top'], w['x0']))
    rows, cur = [], None
    for w in ws:
        cy = (w['top'] + w['bottom']) / 2
        if cur is not None and abs(cur['y'] - cy) <= tol:
            cur['items'].append(w)
            n = len(cur['items'])
            cur['y'] = (cur['y'] * (n - 1) + cy) / n
        else:
            cur = {'y': cy, 'items': [w]}
            rows.append(cur)

    out = []
    for r in rows:
        its = sorted(r['items'], key=lambda w: w['x0'])
        line, end = '', None
        for it in its:
            if end is not None:
                gap = it['x0'] - end
                if gap < 1.5:
                    pass                      # same number split across runs
                elif gap < 10:
                    line += ' '
                else:
                    line += '   '
            line += it['text']
            end = it['x1']
        line = ' '.join(line.split())
        if line:
            out.append(line)
    return out

def extract(path):
    lines = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            lines += assemble(page.extract_words(use_text_flow=False, keep_blank_chars=False))
    return '\n'.join(lines)

if __name__ == '__main__':
    res = {}
    for f in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'slips', '*.pdf'))):
        try:
            res[os.path.basename(f)] = extract(f)
        except Exception as e:
            res[os.path.basename(f)] = 'ERROR: ' + str(e)
    json.dump(res, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'slips_text.json'), 'w'), indent=1)
    print('extracted', len(res), 'files')
