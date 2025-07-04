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