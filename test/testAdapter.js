/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
const setup = require('@iobroker/legacy-testing');

let objects = null;
let states = null;
const onStateChanged = null;

const adapterShortName = setup.adapterName.substring(setup.adapterName.indexOf('.') + 1);

describe(`Test ${adapterShortName} adapter`, function () {
    before(`Test ${adapterShortName} adapter: Start js-controller`, function (_done) {
        this.timeout(600000); // because of first install from npm

        setup.setupController(async () => {
            const config = await setup.getAdapterConfig();
            // enable adapter
            config.common.enabled = true;
            config.common.loglevel = 'debug';

            //config.native.dbtype   = 'sqlite';

            await setup.setAdapterConfig(config.common, config.native);

            setup.startController(
                true,
                (id, obj) => {},
                (id, state) => onStateChanged?.(id, state),
                (_objects, _states) => {
                    objects = _objects;
                    states = _states;
                    _done();
                },
            );
        });
    });

    /*
    ENABLE THIS WHEN ADAPTER RUNS IN DEAMON MODE TO CHECK THAT IT HAS STARTED SUCCESSFULLY
*/
    /*
    it('Test ' + adapterShortName + ' adapter: Check if connected', function (done) {
        this.timeout(60000);
        setTimeout(function () {
            states.getState('hass.0.info.connection', function (err, state) {
                if (err) console.error(err);
                expect(err).to.be.not.ok;
                expect(state).to.be.ok;
                expect(state.val).to.be.true;
                done();
            });
        }, 5000);
    });
*/
    after(`Test ${adapterShortName} adapter: Stop js-controller`, function (done) {
        this.timeout(10000);

        setup.stopController(normalTerminated => {
            console.log(`Adapter normal terminated: ${normalTerminated}`);
            done();
        });
    });
});
