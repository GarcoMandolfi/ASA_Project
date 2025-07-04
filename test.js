import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080/',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
);

const beliefset = new Map();
const knownParcels = new Map();    // id -> {x, y, reward, lastUpdate}
const carryingParcels = new Map(); // id -> {reward, lastUpdate}

let DECAY_INTERVAL = 0;
let OBS_RANGE = 0;
let me = { id: null, x: 0, y: 0 }; // store agent id too

function parseSecondsString(str) {
    if (typeof str !== 'string') return NaN;

    if (str === 'infinite') return Infinity;

    if (str.endsWith('s')) {
        const seconds = parseInt(str.slice(0, -1));
        return isNaN(seconds) ? NaN : seconds * 1000;
    }

    return NaN;
}

client.onConfig(config => {
    console.log("Received config:", config);

    DECAY_INTERVAL = parseSecondsString(config.PARCEL_DECADING_INTERVAL);
    OBS_RANGE = Number(config.PARCELS_OBSERVATION_DISTANCE);

    if (isNaN(DECAY_INTERVAL) || isNaN(OBS_RANGE)) {
        console.error("❌ Invalid config values:", {
            DECAY_INTERVAL,
            OBS_RANGE
        });
    } else {
        console.log("✅ Parsed config:", {
            DECAY_INTERVAL,
            OBS_RANGE
        });
    }

    console.log('decay interval:', DECAY_INTERVAL, 'ms');
    console.log('observation range:', OBS_RANGE, 'tiles');
});

client.onMap((x, y, tiles) => {
    console.log('Map:', x, y, tiles);
});

client.onYou(_me => {
    console.log('You:', _me);
    me = _me;  // now me.id is your agent id
});

client.onAgentsSensing(agents => {
    for (let a of agents) {
        beliefset.set(a.id, a);
    }

    let agentList = Array.from(beliefset.values())
        .map(({ name, x, y, score }) => `${name}(${score}):${x},${y}`)
        .join(' ');
    console.log('Agents:', agentList);
});

client.onParcelsSensing(parcels => {
    const seenNow = new Set(parcels.map(p => p.id));

    // Remove parcels that should be visible but aren't
    for (let [id, parcel] of knownParcels) {
        const dx = Math.abs(parcel.x - me.x);
        const dy = Math.abs(parcel.y - me.y);
        const distance = dx + dy;

        if (distance < OBS_RANGE && !seenNow.has(id)) {
            knownParcels.delete(id);
        }
    }

    for (let p of parcels) {
        beliefset.set(p.id, p);

        if (p.carriedBy === me.id) {
            // Parcel is carried by me — check if just picked up
            if (knownParcels.has(p.id)) {
                // Moved from known to carrying after pickup
                knownParcels.delete(p.id);
                carryingParcels.set(p.id, {
                    reward: p.reward,
                    lastUpdate: Date.now()
                });
            } else {
                // Already carrying, just update reward and timestamp
                carryingParcels.set(p.id, {
                    reward: p.reward,
                    lastUpdate: Date.now()
                });
            }
            continue;
        }

        if (p.carriedBy === null) {
            // Parcel is visible and not carried, update knownParcels
            if (p.reward > 1) {
                knownParcels.set(p.id, {
                    x: p.x,
                    y: p.y,
                    reward: p.reward,
                    lastUpdate: Date.now()
                });
            } else {
                knownParcels.delete(p.id);
                carryingParcels.delete(p.id);
            }
            continue;
        }

        // If carried by someone else, remove from known or carrying
        knownParcels.delete(p.id);
        carryingParcels.delete(p.id);
    }

    printParcels();
});

// Reward decay loop
setInterval(() => {
    if (!isFinite(DECAY_INTERVAL)) return;

    const now = Date.now();

    // Decay knownParcels
    for (let [id, parcel] of knownParcels) {
        const timePassed = now - parcel.lastUpdate;

        if (timePassed >= DECAY_INTERVAL) {
            const ticks = Math.floor(timePassed / DECAY_INTERVAL);
            const newReward = Math.max(1, parcel.reward - ticks);

            if (newReward <= 1) {
                knownParcels.delete(id);
                continue;
            }

            parcel.reward = newReward;
            parcel.lastUpdate += ticks * DECAY_INTERVAL;
            knownParcels.set(id, parcel);
        }
    }

    // Decay carryingParcels
    for (let [id, parcel] of carryingParcels) {
        const timePassed = now - parcel.lastUpdate;

        if (timePassed >= DECAY_INTERVAL) {
            const ticks = Math.floor(timePassed / DECAY_INTERVAL);
            const newReward = Math.max(1, parcel.reward - ticks);

            if (newReward <= 1) {
                carryingParcels.delete(id);
                continue;
            }

            parcel.reward = newReward;
            parcel.lastUpdate += ticks * DECAY_INTERVAL;
            carryingParcels.set(id, parcel);
        }
    }

    printParcels();
}, 1000);

function printParcels() {
    const knownList = Array.from(knownParcels.entries())
        .map(([id, { x, y, reward }]) => `${id}(${reward}):${x},${y}`)
        .join(' ');

    const carryingList = Array.from(carryingParcels.entries())
        .map(([id, { reward }]) => `${id}(${reward})`)
        .join(' ');

    console.log('Known Parcels (tracked):', knownList);
    console.log('Carrying Parcels:', carryingList);
}
