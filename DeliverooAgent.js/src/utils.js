// this function is used to decay the parcels
// it is called every time the agent updates its state
// it is used to decay the parcels based on the decay interval

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

// this function is used to get the key of the predicate
function getPredicateKey(predicate) {
    const [type, ...args] = predicate;

    switch (type) {
        case 'go_pick_up':
            return 'go_pick_up ' + args[2];
        case 'go_deliver':
            return 'go deliver ' + args[0] + ' ' + args[1]; // type:id
        default:
            return predicate.join(' '); // fallback to full string match
    }
}

export {decayParcels as decayParcels}
export {getPredicateKey as getKey}