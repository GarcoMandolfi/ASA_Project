import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080/',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImRjN2Q0MiIsIm5hbWUiOiJNb3J0ZVoiLCJyb2xlIjoidXNlciIsImlhdCI6MTc1MTU0NDM1NX0.F8r_xQkLdeBzklf5zTUbw_L_k5ZW1zWQv5JNCw2f-hw'
);

const beliefset = new Map();    // id -> {name, x, y, score}
const knownParcels = new Map();    // id -> {x, y, reward, lastUpdate}
const carryingParcels = new Map(); // id -> {reward, lastUpdate}
const deliveryPoints = new Map(); // id -> { x, y }


let DECAY_INTERVAL = 0;
let OBS_RANGE = 0;
let me = { id: null, x: 0, y: 0 }; // store agent id too


// Parse duration strings like '1s', '2s', etc. to milliseconds
// For now this is For Decay Interval only, but can be extended for other durations
// 'infinite' is treated as Infinity

function parseDurationToMilliseconds(str) {
    if (typeof str !== 'string') {
        throw new Error(`Invalid input: expected a string but got ${typeof str}`);
    }

    if (str === 'infinite') {
        return Infinity;
    }

    if (str.endsWith('s')) {
        const seconds = parseInt(str.slice(0, -1), 10);
        if (isNaN(seconds)) {
            throw new Error(`Invalid duration format: unable to parse seconds from "${str}"`);
        }
        return seconds * 1000;
    }

    throw new Error(`Invalid duration format: unsupported string "${str}"`);
}

client.onConfig(config => {
    console.log("Received config:", config);

    DECAY_INTERVAL = parseDurationToMilliseconds(config.PARCEL_DECADING_INTERVAL);
    OBS_RANGE = Number(config.PARCELS_OBSERVATION_DISTANCE);

    // console.log('decay interval:', DECAY_INTERVAL, 'ms');
    // console.log('observation range:', OBS_RANGE, 'tiles');
});

// when map is received, update the delivery points
client.onMap((width, height, tiles) => {
    console.log('Map received:', width, height);

    deliveryPoints.clear(); // Clear previous entries
    let tileid = 1;
    for (let tile of tiles) {
        // actually, tile.type is a number, but for some reason it is a string in the client file
        if (parseInt(tile.type) === 2) {
            deliveryPoints.set(tileid, { x: tile.x, y: tile.y });
            tileid++;
        }
    }

    printDeliveryPoints();
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
    // console.log('Agents:', agentList);
});

// Update the parcel in knownParcels
// If the reward is 1 or less, it is removed from knownParcels and carryingParcels
function updateExpiredParcel(parcel) {
    if (parcel.reward > 1) {
        knownParcels.set(parcel.id, {
            x: parcel.x,
            y: parcel.y,
            reward: parcel.reward,
            lastUpdate: Date.now()
        });
    } else {
        knownParcels.delete(parcel.id);
        // carryingParcels.delete(parcel.id);
    }
}

client.onParcelsSensing(parcels => {
    const seenNow = new Set(parcels.map(p => p.id));

    // Rebuild carryingParcels from scratch every time
    
    carryingParcels.clear();

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

        // If the parcel is not in the knownParcels, add it
        if (p.carriedBy === null) {
            updateExpiredParcel(p);
            continue;
        }

        // Fill carryingParcels with parcels currently carried by me
        if (p.carriedBy === me.id) {
            knownParcels.delete(p.id);
            carryingParcels.set(p.id, {
                reward: p.reward,
                lastUpdate: Date.now()
            });
            continue;
        }


        if (p.carriedBy !== null && p.carriedBy !== me.id  ) {
            // If the parcel is carried by someone else, remove it from knownParcels
            knownParcels.delete(p.id);
            continue;
        }
    }

    // printParcels();
});

// Handle parcel decay
function decayParcels(parcelMap, now, decayInterval) {
    for (let [id, parcel] of parcelMap) {
        const timePassed = now - parcel.lastUpdate;

        if (timePassed >= decayInterval) {
            const ticks = Math.floor(timePassed / decayInterval);
            const newReward = Math.max(1, parcel.reward - ticks);

            if (newReward <= 1) {
                parcelMap.delete(id);
                continue;
            }

            parcel.reward = newReward;
            parcel.lastUpdate += ticks * decayInterval;
            parcelMap.set(id, parcel);
        }
    }
}

// Periodically decay parcels every second
// This is a simple simulation of the decay process
setInterval(() => {
    if (!isFinite(DECAY_INTERVAL)) return;

    const now = Date.now();

    decayParcels(knownParcels, now, DECAY_INTERVAL);

    // printParcels();
}, 1000);


// Print the current state of known and carrying parcels
// This function is called after every update to knownParcels and carryingParcels

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

// Print the current state of delivery points
function printDeliveryPoints() {
    const list = Array.from(deliveryPoints.entries())
        .map(([id, { x, y }]) => `${id}: (${x},${y})    `)
        .join(' ');
    console.log('Delivery Points:', list);
}

