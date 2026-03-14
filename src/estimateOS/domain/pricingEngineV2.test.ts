import {
  computePricingV2,
  applyOverride,
  removeOverride,
  clearOverrides,
} from './pricingEngineV2';
import type { VerticalConfig, ServiceConfig, DriverOverrideMap } from '../models/types';

// ─── Minimal test fixtures ────────────────────────────────────────────────────
// Each fixture uses a UNIQUE id so tests never collide in the module-level cache.

const SVC_BASE: ServiceConfig   = { id: 'svc_base',   name: 'Base Svc',   baseMin: 500, baseMax: 1000 };
const SVC_RULES: ServiceConfig  = { id: 'svc_rules',  name: 'Rules Svc',  baseMin: 500, baseMax: 1000 };
const SVC_NEG: ServiceConfig    = { id: 'svc_neg',    name: 'Neg Svc',    baseMin: -100, baseMax: -50 };
const SVC_VAR: ServiceConfig    = { id: 'svc_var',    name: 'Var Svc',    baseMin: 500, baseMax: 1000 };
const SVC_CACHE: ServiceConfig  = { id: 'svc_cache',  name: 'Cache Svc',  baseMin: 500, baseMax: 1000 };

const VERT_EMPTY: VerticalConfig = {
  id: 'vert_empty',
  name: 'Empty Vertical',
  icon: '🔧',
  currency: 'USD',
  variancePct: 0,
  services: [SVC_BASE],
  pricingRules: [],
  intakeQuestions: [],
};

const VERT_RULES: VerticalConfig = {
  id: 'vert_rules',
  name: 'Rules Vertical',
  icon: '🔧',
  currency: 'USD',
  variancePct: 0,
  services: [SVC_RULES],
  pricingRules: [
    { type: 'flat_fee',          id: 'ff1',  label: 'Flat fee',  bucket: 'other',     valueMin: 100, valueMax: 200 },
    { type: 'conditional_addon', id: 'ca1',  label: 'Addon',     bucket: 'labor',     questionId: 'q_bool', triggerValue: 'true', answerValue: 'true', valueMin: 50,  valueMax: 100 },
    { type: 'per_unit',          id: 'pu1',  label: 'Per unit',  bucket: 'materials', questionId: 'q_num',  unitMin: 10,  unitMax: 20, unitLabel: 'sq ft' },
    { type: 'tiered',            id: 'ti1',  label: 'Tiered',    bucket: 'other',     questionId: 'q_tier',
      tieredData: [
        { label: 'Small', minValue: 0,   maxValue: 100,      addMin: 0,   addMax: 50  },
        { label: 'Large', minValue: 100, maxValue: Infinity,  addMin: 100, addMax: 200 },
      ],
    },
    { type: 'multiplier', id: 'mu1', label: 'Multiplier', bucket: 'risk', questionId: 'q_mult', triggerValue: 'yes', answerValue: 'yes', valueMin: 1.2, valueMax: 1.4 },
  ],
  intakeQuestions: [],
};

const VERT_NEG: VerticalConfig   = { ...VERT_EMPTY, id: 'vert_neg',   services: [SVC_NEG]   };
const VERT_VAR: VerticalConfig   = { ...VERT_EMPTY, id: 'vert_var',   variancePct: 0.20, services: [SVC_VAR] };
const VERT_CACHE: VerticalConfig = { ...VERT_EMPTY, id: 'vert_cache', services: [SVC_CACHE] };

// ─── computePricingV2 ─────────────────────────────────────────────────────────

describe('computePricingV2', () => {
  describe('base case (no rules, no answers)', () => {
    it('uses service base range', () => {
      const result = computePricingV2(VERT_EMPTY, SVC_BASE, {}, {});
      expect(result.range.min).toBe(SVC_BASE.baseMin);
      expect(result.range.max).toBe(SVC_BASE.baseMax);
    });

    it('includes a non-editable base driver', () => {
      const result = computePricingV2(VERT_EMPTY, SVC_BASE, {}, {});
      const base = result.drivers.find(d => d.id === 'base');
      expect(base).toBeDefined();
      expect(base!.editable).toBe(false);
    });

    it('sets hasOverrides = false with no overrides', () => {
      const result = computePricingV2(VERT_EMPTY, SVC_BASE, {}, {});
      expect(result.hasOverrides).toBe(false);
    });
  });

  describe('flat_fee rule', () => {
    it('always adds flat fee to totals regardless of answers', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, {}, {});
      const ffDriver = result.drivers.find(d => d.id === 'flat_fee_0');
      expect(ffDriver).toBeDefined();
      expect(ffDriver!.minImpact).toBe(100);
      expect(ffDriver!.maxImpact).toBe(200);
    });
  });

  describe('conditional_addon rule', () => {
    it('adds driver when answer matches trigger', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_bool: 'true' }, {});
      const driver = result.drivers.find(d => d.id === 'conditional_0');
      expect(driver).toBeDefined();
      expect(driver!.minImpact).toBe(50);
    });

    it('does not add driver when answer does not match', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_bool: 'false' }, {});
      const driver = result.drivers.find(d => d.id === 'conditional_0');
      expect(driver).toBeUndefined();
    });
  });

  describe('per_unit rule', () => {
    it('adds per-unit driver scaled by numeric answer', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_num: 10 }, {});
      const driver = result.drivers.find(d => d.id === 'per_unit_0');
      expect(driver).toBeDefined();
      expect(driver!.minImpact).toBe(100); // 10 × 10
      expect(driver!.maxImpact).toBe(200); // 10 × 20
    });

    it('does not add driver when answer is 0', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_num: 0 }, {});
      const driver = result.drivers.find(d => d.id === 'per_unit_0');
      expect(driver).toBeUndefined();
    });
  });

  describe('tiered rule', () => {
    it('matches Small tier for value in [0, 100)', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_tier: 50 }, {});
      const driver = result.drivers.find(d => d.id === 'tiered_0');
      expect(driver).toBeDefined();
      expect(driver!.label).toContain('Small');
      expect(driver!.minImpact).toBe(0);
      expect(driver!.maxImpact).toBe(50);
    });

    it('matches Large tier for value >= 100', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_tier: 200 }, {});
      const driver = result.drivers.find(d => d.id === 'tiered_0');
      expect(driver).toBeDefined();
      expect(driver!.label).toContain('Large');
      expect(driver!.minImpact).toBe(100);
    });
  });

  describe('multiplier rule', () => {
    it('scales the running subtotal (applied last)', () => {
      // Only flat_fee fires (100–200 add), base (500–1000) → subtotal 600–1200 before multiplier
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_mult: 'yes' }, {});
      const multDriver = result.drivers.find(d => d.id === 'multiplier_0');
      expect(multDriver).toBeDefined();
      expect(multDriver!.minImpact).toBeGreaterThan(0);
      expect(multDriver!.maxImpact).toBeGreaterThan(0);
      // impact = subtotal × (factor - 1): 600 × 0.2 = 120 min, 1200 × 0.4 = 480 max
      expect(multDriver!.minImpact).toBeCloseTo(120, 5);
      expect(multDriver!.maxImpact).toBeCloseTo(480, 5);
    });
  });

  describe('rule evaluation order', () => {
    it('multiplier fires after all additive rules, producing a larger impact', () => {
      const answers = { q_bool: 'true', q_num: 5, q_tier: 50, q_mult: 'yes' };
      const result = computePricingV2(VERT_RULES, SVC_RULES, answers, {});
      const multDriver = result.drivers.find(d => d.id === 'multiplier_0');
      expect(multDriver).toBeDefined();
      // With all additive rules: base(500) + flat(100) + addon(50) + perunit(50) + tier(0) = 700 min
      // multiplier impact = 700 * 0.2 = 140
      expect(multDriver!.minImpact).toBeCloseTo(140, 5);
    });
  });

  describe('caching', () => {
    it('returns the same reference for identical inputs', () => {
      const answers = { q_num: 3 };
      const r1 = computePricingV2(VERT_RULES, SVC_RULES, answers, {});
      const r2 = computePricingV2(VERT_RULES, SVC_RULES, answers, {});
      expect(r1).toBe(r2);
    });

    it('returns a different result when answers change', () => {
      const r1 = computePricingV2(VERT_RULES, SVC_RULES, { q_num: 11 }, {});
      const r2 = computePricingV2(VERT_RULES, SVC_RULES, { q_num: 12 }, {});
      expect(r1).not.toBe(r2);
    });

    it('does NOT collide between verticals with same service ID (verticalId in cache key)', () => {
      // VERT_CACHE has no rules, VERT_RULES has rules — same service base values
      const r1 = computePricingV2(VERT_CACHE,  SVC_CACHE,  {}, {});
      // Manually build a second vertical with same service ID but different rules
      const svcSameId: ServiceConfig = { ...SVC_CACHE };
      const vertWithRules: VerticalConfig = {
        ...VERT_RULES,
        id: 'vert_cache_alt',  // different vertical ID
        services: [svcSameId],
      };
      const r2 = computePricingV2(vertWithRules, svcSameId, {}, {});
      // r2 has rules so it has more drivers than r1
      expect(r2.drivers.length).toBeGreaterThan(r1.drivers.length);
    });
  });

  describe('NaN / invalid inputs', () => {
    it('clamps negative base minImpact to 0 in the base driver', () => {
      const result = computePricingV2(VERT_NEG, SVC_NEG, {}, {});
      const base = result.drivers.find(d => d.id === 'base');
      expect(base!.minImpact).toBe(0);
      expect(base!.maxImpact).toBe(0);
    });

    it('produces range of 0–0 when base is fully negative', () => {
      const result = computePricingV2(VERT_NEG, SVC_NEG, {}, {});
      expect(result.range.min).toBe(0);
      expect(result.range.max).toBe(0);
    });

    it('handles non-numeric answers for per_unit (treats as 0 units)', () => {
      const result = computePricingV2(VERT_RULES, SVC_RULES, { q_num: 'not-a-number' as any }, {});
      const driver = result.drivers.find(d => d.id === 'per_unit_0');
      expect(driver).toBeUndefined();
    });
  });

  describe('variance', () => {
    it('applies variance band symmetrically around effective totals', () => {
      // base 500–1000, variancePct = 0.20
      // min = round5(500 × 0.90) = round5(450) = 450
      // max = round5(1000 × 1.10) = round5(1100) = 1100
      const result = computePricingV2(VERT_VAR, SVC_VAR, {}, {});
      expect(result.range.min).toBe(450);
      expect(result.range.max).toBe(1100);
    });

    it('sets variancePct=0 to exact base range', () => {
      const result = computePricingV2(VERT_EMPTY, SVC_BASE, {}, {});
      expect(result.range.min).toBe(SVC_BASE.baseMin);
      expect(result.range.max).toBe(SVC_BASE.baseMax);
    });
  });
});

// ─── applyOverride / removeOverride / clearOverrides ─────────────────────────

describe('applyOverride', () => {
  it('adds a new override entry (immutable — original unchanged)', () => {
    const original: DriverOverrideMap = {};
    const next = applyOverride(original, 'base', { min: 100, max: 200 });
    expect(next['base']).toEqual({ driverId: 'base', min: 100, max: 200 });
    expect(original['base']).toBeUndefined();
  });

  it('merges partial patch into existing override, preserving other fields', () => {
    const existing: DriverOverrideMap = { base: { driverId: 'base', min: 100, max: 200 } };
    const next = applyOverride(existing, 'base', { disabled: true });
    expect(next['base'].disabled).toBe(true);
    expect(next['base'].min).toBe(100);
  });

  it('does not mutate the input map', () => {
    const original: DriverOverrideMap = { x: { driverId: 'x', min: 50 } };
    applyOverride(original, 'y', { min: 10 });
    expect(original['y']).toBeUndefined();
  });
});

describe('removeOverride', () => {
  it('removes the override for a given driverId (immutable)', () => {
    const existing: DriverOverrideMap = { base: { driverId: 'base', min: 100, max: 200 } };
    const next = removeOverride(existing, 'base');
    expect(next['base']).toBeUndefined();
    expect(existing['base']).toBeDefined(); // original unchanged
  });

  it('is idempotent when key does not exist', () => {
    const empty: DriverOverrideMap = {};
    expect(() => removeOverride(empty, 'nonexistent')).not.toThrow();
    expect(removeOverride(empty, 'nonexistent')).toEqual({});
  });
});

describe('clearOverrides', () => {
  it('returns an empty map', () => {
    expect(clearOverrides()).toEqual({});
  });
});

// ─── hashObj stability (via cache) ───────────────────────────────────────────
// Two override maps with same entries but different insertion order should
// hash identically, producing a cache hit (same result reference).

describe('hashObj stability', () => {
  it('override maps with same content in different insertion order hit the cache', () => {
    const ov1: DriverOverrideMap = {};
    ov1['b'] = { driverId: 'b', min: 10 };
    ov1['a'] = { driverId: 'a', min: 20 };

    const ov2: DriverOverrideMap = {};
    ov2['a'] = { driverId: 'a', min: 20 };
    ov2['b'] = { driverId: 'b', min: 10 };

    const r1 = computePricingV2(VERT_EMPTY, SVC_BASE, {}, ov1);
    const r2 = computePricingV2(VERT_EMPTY, SVC_BASE, {}, ov2);
    expect(r1).toBe(r2);
  });
});
