"""Generate the golden test suite. Cases are described in TaxProfile shape;
expected values come from ref.py, an implementation written independently of
the JS engine. Two implementations agreeing is the check."""
import json
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ref import compute, hra_exempt

CAP = {'s80C': 150000, 's80CCD1B': 50000, 's80D': 100000, 'homeLoanInterest': 200000,
       's80TTA': 10000}


def profile(basic=0, hra=0, other=0, bonus=0, enps=0, epf=0, ptax=0,
            rent=0, metro=False, c80=0, ccd1b=0, d80=0, hli=0, e80=0, g80=0,
            savings=0, fd=0):
    return dict(basic=basic, hra=hra, other=other, bonus=bonus, enps=enps, epf=epf,
                ptax=ptax, rent=rent, metro=metro, c80=c80, ccd1b=ccd1b, d80=d80,
                hli=hli, e80=e80, g80=g80, savings=savings, fd=fd)


def expected(p, regime):
    gross = p['basic'] + p['hra'] + p['other'] + p['bonus'] + p['enps']
    other_income = p['savings'] + p['fd']
    enps_cap = p['basic'] * (0.14 if regime == 'new' else 0.10)
    enps_allowed = min(p['enps'], enps_cap)
    if regime == 'new':
        deds = {}
    else:
        deds = {}
        h = hra_exempt(p['hra'], p['basic'], p['rent'], p['metro'])
        if h > 0:
            deds['hra'] = h
        c = min(p['epf'] + p['c80'], CAP['s80C'])
        if c > 0:
            deds['s80C'] = c
        if p['ccd1b'] > 0:
            deds['s80CCD1B'] = min(p['ccd1b'], CAP['s80CCD1B'])
        if p['d80'] > 0:
            deds['s80D'] = min(p['d80'], CAP['s80D'])
        if p['hli'] > 0:
            deds['homeLoanInterest'] = min(p['hli'], CAP['homeLoanInterest'])
        if p['e80'] > 0:
            deds['s80E'] = p['e80']
        if p['g80'] > 0:
            deds['s80G'] = p['g80']
        if p['savings'] > 0:
            deds['s80TTA'] = min(p['savings'], CAP['s80TTA'])
    r = compute(gross, other_income, deds, regime,
                employer_nps=enps_allowed,
                professional_tax=p['ptax'] if regime == 'old' else 0)
    return r


CASES = [
  ("Zero tax — 7L gross, new regime rebate", profile(basic=350000, hra=175000, other=175000)),
  ("Rebate ceiling — 12.75L gross, exactly nil under new", profile(basic=637500, hra=318750, other=318750)),
  ("Marginal relief — 12.80L gross, just past the cliff", profile(basic=640000, hra=320000, other=320000)),
  ("Marginal relief — 13.00L gross", profile(basic=650000, hra=325000, other=325000)),
  ("Old-regime rebate — 5.5L gross, nil under old", profile(basic=275000, hra=137500, other=137500)),
  ("The worked example — 18L, HRA + 80C + employer NPS",
   profile(basic=750000, hra=375000, other=600000, enps=75000, epf=90000, rent=360000, metro=True, c80=60000)),
  ("18L gross, no deductions at all", profile(basic=750000, hra=375000, other=600000, enps=75000)),
  ("Old regime wins — 18L with metro rent and a home loan",
   profile(basic=900000, hra=450000, other=450000, epf=108000, c80=42000,
           ccd1b=50000, d80=50000, hli=200000, rent=480000, metro=True)),
  ("Heavy deductions — 18L, old regime just ahead",
   profile(basic=750000, hra=0, other=975000, enps=75000, epf=90000, c80=60000,
           ccd1b=50000, d80=50000, hli=200000, e80=170000)),
  ("Ten rupees from break-even — 18L",
   profile(basic=750000, hra=0, other=975000, enps=75000, epf=90000, c80=60000, e80=466650)),
  ("No HRA component at all — 15L", profile(basic=750000, hra=0, other=750000, epf=90000, c80=60000)),
  ("Non-metro HRA — 12L", profile(basic=500000, hra=200000, other=500000, rent=240000, metro=False, epf=60000)),
  ("Rent below 10% of basic — HRA exemption nil",
   profile(basic=600000, hra=240000, other=360000, rent=50000, metro=True)),
  ("Employer NPS above the old-regime 10% cap",
   profile(basic=1000000, hra=0, other=800000, enps=140000, epf=120000)),
  ("Surcharge threshold — 50.75L gross, no surcharge yet", profile(basic=2537500, hra=0, other=2537500)),
  ("Surcharge marginal relief — 51.75L gross", profile(basic=2587500, hra=0, other=2587500)),
  ("Surcharge 15% band — 1.2cr gross", profile(basic=6000000, hra=0, other=6000000)),
  ("Surcharge 25% band — 2.5cr gross", profile(basic=12500000, hra=0, other=12500000)),
  ("Old-regime 37% band — 6cr gross", profile(basic=30000000, hra=0, other=30000000)),
  ("Other income — savings + FD interest, 80TTA applies",
   profile(basic=500000, hra=250000, other=250000, epf=60000, savings=14000, fd=45000)),
  ("Bonus-heavy — 14L salary + 6L bonus",
   profile(basic=583000, hra=291500, other=525500, bonus=600000, epf=70000, rent=300000, metro=True)),
]

out = []
for name, p in CASES:
    out.append({
        'name': name, 'profile': p,
        'expected': {
            'neu': {k: expected(p, 'new')[k] for k in ('taxable', 'base', 'rebate', 'surcharge', 'cess', 'total')},
            'old': {k: expected(p, 'old')[k] for k in ('taxable', 'base', 'rebate', 'surcharge', 'cess', 'total')},
        }
    })

print(json.dumps(out, indent=1))
