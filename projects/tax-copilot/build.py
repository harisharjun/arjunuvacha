import json, io, os, re

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src')
TEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test')
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')

read = lambda p: open(os.path.join(SRC, p), encoding='utf-8').read()

head = read('00_head.html')
body = read('10_body.html')
cases = open(os.path.join(TEST, 'cases.json'), encoding='utf-8').read().strip()

js = "\n".join([
    read('20_rulepack.js'),
    read('30_engine.js'),
    read('40_tests.js').replace('__CASES__', cases),
    read('50_parser.js'),
    read('60_interview.js'),
    read('80_groq.js'),
    read('70_ui.js'),
])
# strip the node-only export blocks (they can span several lines)
js = re.sub(r"if \(typeof module !== 'undefined'\) module\.exports = \{[^}]*\};", "", js)

PDFJS = ('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>\n'
         '<script>try{if(window["pdfjsLib"])pdfjsLib.GlobalWorkerOptions.workerSrc='
         '"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";}catch(e){}</script>\n')

inner = body + "\n" + PDFJS + "<script>\n" + js + "\n</script>\n"

# ---- standalone: full document, opened from disk ----
standalone = ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
              "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
              + head + "</head>\n<body>\n" + inner + "</body>\n</html>\n")
open(os.path.join(DIST, 'tax-copilot.html'), 'w', encoding='utf-8').write(standalone)

# ---- artifact: no skeleton, the host supplies it ----
open(os.path.join(DIST, 'tax-copilot-artifact.html'), 'w', encoding='utf-8').write(head + "\n" + inner)

for f in (os.path.join(DIST,'tax-copilot.html'), os.path.join(DIST,'tax-copilot-artifact.html')):
    print(f, round(os.path.getsize(f) / 1024, 1), 'KB')
