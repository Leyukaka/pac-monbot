# Liste les textes du site (HTML statique + appels t()/tr()) et signale ceux absents de site/i18n-dict.js.
# Liste les textes à traduire du site (HTML statique + appels t()/tr()) et vérifie site/i18n-dict.js.
import re, sys, json
from html.parser import HTMLParser
# Usage : python tools/i18n-check.py site
root = sys.argv[1] if len(sys.argv) > 1 else "site"
keys = []
def add(k):
    k = k.strip()
    if not k or not re.search(r"[A-Za-zÀ-ÿ]", k): return
    if re.fullmatch(r"(BT\d+|GP\d+|BP\d+|EB\d+|VVM 500|PAC|COP|DM|Hz|kWh|kW|W|€|K|°C|max|min|-|PAC/Monbot|PAC Monbot)( -)?", k): return
    if k not in keys: keys.append(k)

class P(HTMLParser):
    def __init__(s): super().__init__(); s.skip = 0
    def handle_starttag(s, tag, attrs):
        if tag in ("script", "style"): s.skip += 1
        a = dict(attrs)
        for n in ("aria-label", "title", "alt"):
            if a.get(n): add(a[n])
        if tag == "meta" and a.get("name") == "description": add(a.get("content", ""))
    def handle_endtag(s, tag):
        if tag in ("script", "style"): s.skip -= 1
    def handle_data(s, d):
        if not s.skip: add(d)
for f in ("index.html", "analyse.html", "couts.html"):
    P().feed(open(f"{root}/{f}", encoding="utf-8").read())
for f, fn in (("app.js", "t"), ("rapport.js", "tr"), ("couts.js", "tr"), ("i18n.js", "t"), ("theme.js", "t")):
    src = open(f"{root}/{f}", encoding="utf-8").read()
    for m in re.finditer(r'\b' + fn + r'\(\s*"((?:[^"\\]|\\.)*)"', src): add(m.group(1))
    for m in re.finditer(r'\b' + fn + r'\(\s*([a-z]+ > 1 \? )?"((?:[^"\\]|\\.)*)" : "((?:[^"\\]|\\.)*)"', src):
        add(m.group(2)); add(m.group(3))
# trLabel words + table heads + long-form units
for k in ["€/kWh HT selon l'heure", "fournisseur", "réseau", "compensation", "TVA", "partagé", "à",
          "Mois", "Jours", "Maison kWh", "Maison €", "Partagé kWh", "Partage €", "PAC kWh", "PAC €", "Pic kW",
          "heures", "jours", "h", "j", "{n} alarmes", "{n} alarme"]:
    add(k) if k not in ("h",) else (keys.append(k) if k not in keys else None)
# Compare avec site/i18n-dict.js : clés manquantes (le texte reste en français).
src = open(f"{root}/i18n-dict.js", encoding="utf-8").read()
skip = {"Monbot", "texte source", "POWER", "PAC/POWER", "3 kW", "7 kW", "12 kW", "17 kW"}
for lang in ("en", "de"):
    m = re.search(r"\b" + lang + r": (\{.*?\}),\n", src, re.S)
    tab = json.loads(m.group(1))
    miss = [k for k in keys if k not in tab and k not in skip]
    print(f"{lang}: {len(tab)} traductions, {len(miss)} manquantes")
    for k in miss: print("  -", k)
