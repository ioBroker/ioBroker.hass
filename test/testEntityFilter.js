const { expect } = require('chai');
const { isExcluded } = require('../build/lib/entityFilter');

describe('entityFilter.isExcluded', () => {
    it('returns false for an empty pattern list', () => {
        expect(isExcluded('switch.iob_anything', [])).to.equal(false);
    });

    it('matches a simple glob with leading wildcard', () => {
        expect(isExcluded('switch.iob_shelly_xyz', ['*.iob_*'])).to.equal(true);
    });

    it('matches the bridge mirror naming pattern', () => {
        expect(isExcluded('light.iob_ha_eg_wz1__e_licht_decke', ['*.iob_*__*'])).to.equal(true);
    });

    it('handles entities that miss a required literal segment', () => {
        // *.iob_*__* requires the literal `__` segment — entities without it do not match
        expect(isExcluded('switch.iob_', ['*.iob_*__*'])).to.equal(false);
        expect(isExcluded('switch.iob_foo', ['*.iob_*__*'])).to.equal(false);
        // Naming-Convention safety: similarly named entities without `__` are safe
        expect(isExcluded('sensor.scheune_temperatur', ['*.sc_*__*'])).to.equal(false);
    });

    it('matches multiple patterns (OR semantic)', () => {
        const patterns = ['*.iob_*__*', '*.knx_*', '*.ha_*__*'];
        expect(isExcluded('switch.knx_foo', patterns)).to.equal(true);
        expect(isExcluded('switch.ha_eg_wz1__e_licht_decke', patterns)).to.equal(true);
        expect(isExcluded('switch.something_else', patterns)).to.equal(false);
    });

    it('is case sensitive', () => {
        expect(isExcluded('switch.IOB_foo', ['*.iob_*'])).to.equal(false);
        expect(isExcluded('switch.iob_foo', ['*.IOB_*'])).to.equal(false);
    });

    it('treats * as matching any characters including dots', () => {
        // We use full entity_id including the leading domain, so this is fine.
        expect(isExcluded('switch.iob_foo', ['*foo*'])).to.equal(true);
    });

    it('escapes regex metacharacters in patterns', () => {
        // `.` in pattern matches literal `.`, not "any char"
        expect(isExcluded('switch.iob_foo', ['switch.iob_foo'])).to.equal(true);
        expect(isExcluded('switchXiob_foo', ['switch.iob_foo'])).to.equal(false);
    });
});
