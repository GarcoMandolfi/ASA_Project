import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { decayParcels } from "./utils.js"

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

function distance( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}

let DECAY_INTERVAL = 0;
let OBS_RANGE = 0;
let MOVE_DURATION = 0;
let MOVE_STEPS = 0;
let MAX_PARCELS = 0;

client.onConfig(config => {

    let decayInterval = config.PARCEL_DECADING_INTERVAL

    if (typeof decayInterval === 'string' && decayInterval.endsWith('s'))
        DECAY_INTERVAL = parseInt(decayInterval.slice(0, -1), 10) * 1000;
    else
        DECAY_INTERVAL = Infinity;

    OBS_RANGE = Number(config.PARCELS_OBSERVATION_DISTANCE);

    MOVE_DURATION = Number(config.MOVEMENT_DURATION);
    MOVE_STEPS = Number(config.MOVEMENT_STEPS);
    MAX_PARCELS = Number(config.PARCELS_MAX);
});

setInterval(() => {
    if (!isFinite(DECAY_INTERVAL)) return;

    const carriedTotal = carriedValue(carriedParcels);

    decayParcels();  // Use correct map

    printParcels();

    console.log("Total carried reward: "+ carriedTotal);
}, 1000);


/**
 * Belief revision
 */

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: null, name: null, x: null, y: null, score: null};

client.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score
} )

const deliveryCells = new Map();
client.onMap((width, height, tiles) => {
    for (const tile of tiles) {
        if (tile.type === 2) {
            deliveryCells.set(tile.x * 1000 + tile.y, tile);
        }
    }
})

/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, lastSeen:number} > }
 */
const parcels = new Map();

/**
 * @type { Map< string, {id: string, reward:number, lastSeen:number} > }
 */
const carriedParcels = new Map();

function parcelUpdate(parcel) {
    if ( parcel.reward > 1 ) {
        parcels.set ( parcel.id, {
            ...parcel,
            lastSeen: Date.now()
        })
    }
    else
        parcels.delete(parcel.id);
}

function carriedValue(parcels) {
    return Array.from(carriedParcels.values()).reduce((sum, p) => sum + (p.reward || 0), 0);
}

client.onParcelsSensing( async (pp) => {
    carriedParcels.clear();

    for (const [id, parcel] of parcels) {
        if (distance({ x: parcel.x, y: parcel.y }, me) < OBS_RANGE && !pp.find(p => p.id === parcel.id))
            parcels.delete(id);
    }

    for (const p of pp) {
        if (p.carriedBy === me.id && !carriedParcels.has(p.id)) {
            parcels.delete(p.id);
            carriedParcels.set(p.id, {id:p.id, reward:p.reward, lastSeen:Date.now()});
        }
        else if (p.carriedBy === null)
            parcelUpdate(p);
        else
            parcels.delete(p.id);
    }
})

function printParcels() {
    const knownList = Array.from(parcels.entries())
        .map(([id, { x, y, reward }]) => `${id}(${reward}):${x},${y}`)
        .join(' ');

    const carryingList = Array.from(carriedParcels.entries())
        .map(([id, { reward }]) => `${id}(${reward})`)
        .join(' ');

    console.log('Known Parcels (tracked):', knownList);
    console.log('Carrying Parcels:', carryingList);
}

/**
 * @type { Map< string, {id: string, x:number, y:number} > }
 */
const agents = new Map();

client.onAgentsSensing ( aa => {

    for (const a of aa) {
        agents.set(a.id, a);
    }

})


function generateOptions () {

    const carriedTotal = carriedValue(carriedParcels);

    let best_option = null;
    let best_distance = Number.MAX_VALUE;

    // Check delivery option if carrying valuable parcels
    if (carriedTotal != 0) {
        for (const cell of deliveryCells.values()) {
            const d = distance(me, {x: cell.x, y: cell.y});
            if (d < best_distance) {
                best_distance = d;
                best_option = ['go_deliver', cell.x, cell.y];
            }
        }
    }

    // Always consider pickup options too, and pick nearest
    for (const parcel of parcels.values()) {
        if (!parcel.carriedBy) {
            const d = distance(me, {x: parcel.x, y: parcel.y});
            if (d < best_distance) {
                best_distance = d;
                best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, parcel.reward, parcel.lastSeen];
            }
        }
    }

    // Push the best option found
    if (best_option)
        myAgent.push(best_option);
    else {
        myAgent.push(['idle']);
    }

}

/**
 * Generate options at every sensing event
 */
client.onParcelsSensing( generateOptions )
client.onAgentsSensing( generateOptions )
client.onYou( generateOptions )

function getScore ( predicate ) {

    const type = predicate[0];

    if (type == 'go_deliver') {

        const x = predicate[1];
        const y = predicate[2];
        let deliveryDistance = distance ({x, y}, me);
        let deliveryReward = carriedValue (carriedParcels);

        const decayInterval = !isFinite(DECAY_INTERVAL) ? 20 : DECAY_INTERVAL;
        const moveDuration = MOVE_DURATION || 200;
        const steps = deliveryDistance / (MOVE_STEPS || 1);
        const deliveryTime = steps * moveDuration;
        const expectedDecay = deliveryTime / decayInterval;

        let score = deliveryReward - deliveryDistance * 2 - expectedDecay;

        const pressure = carriedParcels.size / MAX_PARCELS;
        score += pressure * 10;

        score = Math.min(score, 0);

        return score;
    }

    if (type == 'go_pick_up') {
        
        const x = predicate[1];
        const y = predicate[2];

        const d = distance({x, y}, me);
        const timeSinceSeen = Date.now() - predicate[5];
        const decaySteps = Math.floor(timeSinceSeen / DECAY_INTERVAL);
        const rewardEstimate = predicate[4] - decaySteps;

        const normalizedReward = Math.max(rewardEstimate, 0);
        const score = 2 * normalizedReward / (d + 1); // +1 to avoid division by zero

        return score;
    }

    if (type == 'idle')
        return -1;

    return 0;
}

function stillValid (predicate) {

    const type = predicate[0];

    switch (type) {
        case 'go_pick_up':
            let id = predicate[3];
            let p = parcels.get(id);
            if (p && p.carriedBy) return false;
            return true;
        case 'go_deliver':
            if (carriedParcels.size == 0)
                return false;
            return true;
        case 'idle':
            // If not carrying any parcels and there are no free parcels, remain idle
            if (carriedParcels.size === 0 && parcels.size == 0)
                return true;
            return false;
        default:
            return false;
    }

}

/**
 * Intention revision loop
 */
class IntentionRevision {

    #intention_queue = new Array();
    get intention_queue () {
        return this.#intention_queue;
    }

    async loop ( ) {
        while ( true ) {
            // Consumes intention_queue if not empty
            if ( this.intention_queue.length > 0 ) {
                console.log( 'intentionRevision.loop', this.intention_queue.map(i=>i.predicate) );
            
                // Current intention
                const intention = this.intention_queue[0];
                
                // Is queued intention still valid? Do I still want to achieve it?
                // TODO this hard-coded implementation is an example
                let id = intention.predicate[2]
                let p = parcels.get(id)
                if ( !stillValid(intention.predicate) ) {
                    console.log( 'Skipping intention because no more valid', intention.predicate );
                    this.intention_queue.shift();
                    continue;
                }

                // Start achieving intention
                await intention.achieve()
                // Catch eventual error and continue
                .catch( error => {
                    console.log( 'Failed intention', ...intention.predicate, 'with error:', ...error )
                } );

                // Remove from the queue
                this.intention_queue.shift();
            }
            // Postpone next iteration at setImmediate
            await new Promise( res => setImmediate( res ) );
        }
    }

    // async push ( predicate ) { }

    log ( ...args ) {
        console.log( ...args )
    }

}

class IntentionRevisionReplace extends IntentionRevision {

    async push(predicate) {

        // Find existing index with same id (only for go_pick_up)
        // Check if already queued
        const last = this.intention_queue.at( this.intention_queue.length - 1 );
        
        if ( last && last.predicate.slice(0, 3).join(' ') == predicate.slice(0, 3).join(' ') ) {
            return; // intention is already being achieved
        }

        // Check if there is already an intention with the same first 4 elements
        if (this.intention_queue.some(i =>
            i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ')
        )) {
            return;
        }
        
        console.log( 'IntentionRevisionReplace.push', predicate );
        const intention = new Intention( this, predicate );
        this.intention_queue.push( intention );

        // Sort by score descending
        this.intention_queue.sort((a, b) => {
            return getScore(b.predicate) - getScore(a.predicate);
        });

        // Stop current if not at top
        if (last) {
            last.stop();
        }
    }


}

/**
 * Start intention revision loop
 */

// const myAgent = new IntentionRevisionQueue();
const myAgent = new IntentionRevisionReplace();
// const myAgent = new IntentionRevisionRevise();
myAgent.loop();



/**
 * Intention
 */
class Intention {

    // Plan currently used for achieving the intention 
    #current_plan;
    
    // This is used to stop the intention
    #stopped = false;
    get stopped () {
        return this.#stopped;
    }
    stop () {
        // this.log( 'stop intention', ...this.#predicate );
        this.#stopped = true;
        if ( this.#current_plan)
            this.#current_plan.stop();
    }

    /**
     * #parent refers to caller
     */
    #parent;

    /**
     * @type { any[] } predicate is in the form ['go_to', x, y]
     */
    get predicate () {
        return this.#predicate;
    }
    /**
     * @type { any[] } predicate is in the form ['go_to', x, y]
     */
    #predicate;

    constructor ( parent, predicate ) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    log ( ...args ) {
        if ( this.#parent && this.#parent.log )
            this.#parent.log( '\t', ...args )
        else
            console.log( ...args )
    }

    #started = false;
    /**
     * Using the plan library to achieve an intention
     */
    async achieve () {
        // Cannot start twice
        if ( this.#started)
            return this;
        else
            this.#started = true;

        // Trying all plans in the library
        for (const planClass of planLibrary) {

            // if stopped then quit
            if ( this.stopped ) throw [ 'stopped intention', ...this.predicate ];

            // if plan is 'statically' applicable
            if ( planClass.isApplicableTo( ...this.predicate ) ) {
                // plan is instantiated
                this.#current_plan = new planClass(this.#parent);
                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);
                // and plan is executed and result returned
                try {
                    const plan_res = await this.#current_plan.execute( ...this.predicate );
                    this.log( 'succesful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', plan_res );
                    return plan_res
                // or errors are caught so to continue with next plan
                } catch (error) {
                    this.log( 'failed intention', ...this.predicate,'with plan', planClass.name, 'with error:', error );
                }
            }

        }

        // if stopped then quit
        if ( this.stopped ) throw [ 'stopped intention', ...this.predicate ];

        // no plans have been found to satisfy the intention
        // this.log( 'no plan satisfied the intention ', ...this.predicate );
        throw ['no plan satisfied the intention ', ...this.predicate ]
    }

}

/**
 * Plan library
 */
const planLibrary = [];

class Plan {

    // This is used to stop the plan
    #stopped = false;
    stop () {
        // this.log( 'stop plan' );
        this.#stopped = true;
        for ( const i of this.#sub_intentions ) {
            i.stop();
        }
    }
    get stopped () {
        return this.#stopped;
    }

    /**
     * #parent refers to caller
     */
    #parent;

    constructor ( parent ) {
        this.#parent = parent;
    }

    log ( ...args ) {
        if ( this.#parent && this.#parent.log )
            this.#parent.log( '\t', ...args )
        else
            console.log( ...args )
    }

    // this is an array of sub intention. Multiple ones could eventually being achieved in parallel.
    #sub_intentions = [];

    async subIntention ( predicate ) {
        const sub_intention = new Intention( this, predicate );
        this.#sub_intentions.push( sub_intention );
        return sub_intention.achieve();
    }

}

class GoPickUp extends Plan {

    static isApplicableTo ( go_pick_up, x, y, id ) {
        return go_pick_up == 'go_pick_up';
    }

    async execute ( go_pick_up, x, y ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y] );
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await client.emitPickup()
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        return true;
    }

}

class GoDeliver extends Plan {

    static isApplicableTo ( go_deliver, x, y ) {
        return go_deliver == 'go_deliver';
    }

    async execute ( go_deliver, x, y ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y] );
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await client.emitPutdown()
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        return true;
    }

}

class BlindMove extends Plan {

    static isApplicableTo ( go_to, x, y ) {
        return go_to == 'go_to';
    }

    async execute ( go_to, x, y ) {

        while ( me.x != x || me.y != y ) {

            if ( this.stopped ) throw ['stopped']; // if stopped then quit

            let moved_horizontally;
            let moved_vertically;
            
            // this.log('me', me, 'xy', x, y);

            if ( x > me.x )
                moved_horizontally = await client.emitMove('right')
                // status_x = await this.subIntention( 'go_to', {x: me.x+1, y: me.y} );
            else if ( x < me.x )
                moved_horizontally = await client.emitMove('left')
                // status_x = await this.subIntention( 'go_to', {x: me.x-1, y: me.y} );

            if (moved_horizontally) {
                me.x = moved_horizontally.x;
                me.y = moved_horizontally.y;
            }

            if ( this.stopped ) throw ['stopped']; // if stopped then quit

            if ( y > me.y )
                moved_vertically = await client.emitMove('up')
                // status_x = await this.subIntention( 'go_to', {x: me.x, y: me.y+1} );
            else if ( y < me.y )
                moved_vertically = await client.emitMove('down')
                // status_x = await this.subIntention( 'go_to', {x: me.x, y: me.y-1} );

            if (moved_vertically) {
                me.x = moved_vertically.x;
                me.y = moved_vertically.y;
            }
            
            if ( ! moved_horizontally && ! moved_vertically) {
                this.log('stucked');
                throw 'stucked';
            } else if ( me.x == x && me.y == y ) {
                // this.log('target reached');
            }
            
        }

        return true;

    }
}

function isFree(x, y) {
    
    for (const a of agents.values()) {
        if (a.x == x && a.y == y) return false;
    }

    return true;
}

class IdleMove extends Plan {

    static isApplicableTo ( idle ) {
        return idle == 'idle';
    }

    static directions = ['up', 'right', 'down', 'left'];
    static LastDir = Math.floor(Math.random() * IdleMove.directions.length);

    async execute ( go_to ) {

        // // Up: [0, 0.25] Down: [0.25, 0.5] Left:[0.5, 0.75] Right:[0.75, 1]
        // let directions = ['up', 'right', 'down', 'left'];
        // let LastDir = Math.floor(Math.random() * directions.length);

        if ( this.stopped ) throw ['stopped']; // if stopped then quit

        let rand = Math.random();
        let index;
        let dir;
        let moved;
        if (rand < 0.65) {
            index = IdleMove.LastDir;
        } else if (rand < 0.8) {
            index = (IdleMove.LastDir + 3) % 4;
        } else if (rand < 0.95) {
            index = (IdleMove.LastDir + 1) % 4;
        } else {
            index = (IdleMove.LastDir + 1) % 2;
        }

        dir = IdleMove.directions[index];

        let x = me.x;
        let y = me.y

        switch(dir) {
            case 'up':
                if (isFree(x, y + 1))
                    moved = await client.emitMove('up');
                break;
            case 'down':
                if (isFree(x, y - 1))
                    moved = await client.emitMove('down');
                break;
            case 'left':
                if (isFree(x - 1, y))
                    moved = await client.emitMove('left');
                break;
            case 'right':
                if (isFree(x + 1, y))
                    moved = await client.emitMove('right');
        }

        if (moved) {
            IdleMove.LastDir = index;
        }
        else {
            IdleMove.LastDir = (IdleMove.LastDir + 1) % 2;
        }

        return true;

    }

}

// plan classes are added to plan library 
planLibrary.push( GoPickUp )
planLibrary.push( GoDeliver )
planLibrary.push( BlindMove )
planLibrary.push( IdleMove )
