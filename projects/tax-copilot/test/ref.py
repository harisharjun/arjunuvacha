"""Independent reference implementation of Indian income tax for salaried individuals.
Written separately from the JS engine so the two can be cross-checked.
FY 2026-27 and FY 2025-26 (identical rate structure).
"""
from math import floor

NEW_SLABS = [(0, 400000, 0.00), (400000, 800000, 0.05), (800000, 1200000, 0.10),
             (1200000, 1600000, 0.15), (1600000, 2000000, 0.20),
             (2000000, 2400000, 0.25), (2400000, None, 0.30)]
OLD_SLABS = [(0, 250000, 0.00), (250000, 500000, 0.05), (500000, 1000000, 0.20),
             (1000000, None, 0.30)]

NEW_SURCHARGE = [(5000000, 0.10), (10000000, 0.15), (20000000, 0.25)]
OLD_SURCHARGE = [(5000000, 0.10), (10000000, 0.15), (20000000, 0.25), (50000000, 0.37)]

CESS = 0.04


def slab_tax(taxable, slabs):
    t = 0.0
    for lo, hi, rate in slabs:
        if taxable <= lo:
            break
        top = taxable if hi is None else min(taxable, hi)
        t += (top - lo) * rate
    return t


def surcharge_rate(total_income, bands):
    r = 0.0
    for threshold, rate in bands:
        if total_income > threshold:
            r = rate
    return r


def surcharge_with_relief(taxable, base_tax, bands, slabs):
    """Surcharge with marginal relief at each threshold."""
    rate = surcharge_rate(taxable, bands)
    if rate == 0:
        return 0.0
    sc = base_tax * rate
    # find the threshold just crossed
    threshold = max(t for t, _ in bands if taxable > t)
    # tax+surcharge at the threshold
    tax_at = slab_tax(threshold, slabs)
    prev_rate = surcharge_rate(threshold, bands)
    total_at = tax_at + tax_at * prev_rate
    excess = taxable - threshold
    if (base_tax + sc) - total_at > excess:
        sc = total_at + excess - base_tax
        sc = max(sc, 0.0)
    return sc


def compute(gross_salary, other_income, deductions, regime,
            employer_nps=0.0, professional_tax=0.0):
    """deductions: dict of old-regime-only chapter VI-A + HRA + 24(b) amounts."""
    if regime == 'new':
        std = 75000
        slabs, bands = NEW_SLABS, NEW_SURCHARGE
        allowed = employer_nps          # 80CCD(2) only
        rebate_limit, rebate_max, marginal = 1200000, 60000, True
    else:
        std = 50000
        slabs, bands = OLD_SLABS, OLD_SURCHARGE
        allowed = employer_nps + professional_tax + sum(deductions.values())
        rebate_limit, rebate_max, marginal = 500000, 12500, False

    std = min(std, gross_salary)
    net_salary = gross_salary - std
    gti = net_salary + other_income
    taxable = max(0.0, gti - allowed)
    taxable = floor(taxable / 10) * 10   # rounding u/s 288A to nearest 10

    base = slab_tax(taxable, slabs)

    rebate = 0.0
    if taxable <= rebate_limit:
        rebate = min(base, rebate_max)
    elif marginal:
        # marginal relief: tax cannot exceed income above the limit
        excess = taxable - rebate_limit
        if base > excess:
            rebate = base - excess
    tax_after = base - rebate

    sc = surcharge_with_relief(taxable, tax_after, bands, slabs) if tax_after > 0 else 0.0
    cess = (tax_after + sc) * CESS
    total = tax_after + sc + cess
    return {
        'std': std, 'gti': gti, 'deductions': allowed, 'taxable': taxable,
        'base': round(base, 2), 'rebate': round(rebate, 2),
        'taxAfterRebate': round(tax_after, 2), 'surcharge': round(sc, 2),
        'cess': round(cess, 2), 'total': round(total / 10) * 10,
        'totalRaw': round(total, 2),
    }


def hra_exempt(hra_received, basic, rent_paid, metro):
    if rent_paid <= 0 or hra_received <= 0:
        return 0.0
    return max(0.0, min(hra_received,
                        rent_paid - 0.10 * basic,
                        (0.50 if metro else 0.40) * basic))


if __name__ == '__main__':
    import json
    cases = []

    def case(name, **kw):
        cases.append(dict(name=name, **kw))

    # 1. The brief's worked example: 18L gross, HRA 2.1L exempt, 80C 1.5L, employer NPS 75k
    for regime in ('old', 'new'):
        r = compute(1800000, 0, {'hra': 210000, '80C': 150000}, regime, employer_nps=75000)
        print(regime, json.dumps(r, indent=None))

    print('--- zero deduction 18L ---')
    for regime in ('old', 'new'):
        print(regime, compute(1800000, 0, {}, regime, employer_nps=75000))

    print('--- break-even search 18L ---')
    newt = compute(1800000, 0, {}, 'new', employer_nps=75000)['total']
    lo, hi = 0, 900000
    for _ in range(60):
        mid = (lo + hi) / 2
        if compute(1800000, 0, {'x': mid}, 'old', employer_nps=75000)['total'] > newt:
            lo = mid
        else:
            hi = mid
    print('break-even deductions ~', round(hi))

    print('--- rebate edge ---')
    print('12.75L gross new:', compute(1275000, 0, {}, 'new'))
    print('12.80L gross new:', compute(1280000, 0, {}, 'new'))
    print('13.00L gross new:', compute(1300000, 0, {}, 'new'))
    print('7.5L gross old (rebate):', compute(550000, 0, {}, 'old'))
    print('--- surcharge edge ---')
    print('50L taxable new:', compute(5075000, 0, {}, 'new'))
    print('51L gross new:', compute(5175000, 0, {}, 'new'))
