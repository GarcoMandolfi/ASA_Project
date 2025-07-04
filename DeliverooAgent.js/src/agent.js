import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

function distance( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}

const deliveryCells = new Map();
client.onMap((width, height, tiles) => {
    for (const tile of tiles) {
        if (parseInt(tile.type) === 2) {
            deliveryCells.set(tile.x * 1000 + tile.y, tile);
        }
    }
})

const me = {id: null, name: null, x: null, y: null, score: null};
client.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score
} )

/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, lastSeen:number} > }
 */
const parcels = new Map();
client.onParcelsSensing( async (pp) => {
    for (const p of pp) {
        parcels.set(p.id, {...p, lastSeen:Date.now()});
    }
    for (const [id, parcel] of parcels) {
        if (!pp.find(p => p.id === id)) {
            const positionSeen = pp.some(p => p.x === parcel.x && p.y === parcel.y);
            if (positionSeen) parcels.delete(id);
        }
    }
    for (const p of parcels.values()) {
        console.log('Parcel present at [' + p.x + ',' + p.y +
            '] last seen ' + (Date.now() - p.lastSeen) / 1000 + ' ms ago');
    }
})

function generateOptions () {

    const options = [];

    for (const parcel of parcels.values()) {
        if(!parcel.carriedBy)
            options.push(['go_pickup', parcel.id, parcel.x, parcel.y, parcel.reward, parcel.lastSeen])
    }

    for (const delivery of deliveryCells.values()) {
        options.push(['go_deliver', delivery.x, delivery.y])
    }

    let bestOption;
    let bestScore = Number.MIN_VALUE;
    for (const opt of options) {
        if ( opt[0] == 'go_pick_up' ) {
            let [_, x, y, reward, lastSeen] = opt;
            let d = distance( {x, y}, me);
            let timeSpan = Date.now() - lastSeen;
            let score = reward**2 - timeSpan - d;
            if (score > bestScore) {
                bestScore = score;
                bestOption = opt;
            }
        }
    }

    if ( bestOption )
        myAgent.push( bestOption )

}

client.onParcelsSensing( generateOptions )
client.onAgentsSensing( generateOptions )
client.onYou( generateOptions )

class IntentionRevision {

    #intention_queue = new Array();
    get intention_queue () {
        return this.#intention_queue;
    }

    async loop() {

        while (true) {
            if (this.intention_queue.length > 0) {
                console.log( 'intentionRevision.loop', this.intention_queue.map(i=>i.predicate) );

                const intention = this.intention_queue[0];

                // if (intention == 'go_pick_up'){
                //     let id = intention.predicate[1]
                //     let p = parcels.get(id)
                //     if(p && p.carriedBy){
                //         console.log( 'Skipping intention because no more valid', intention.predicate );
                //         continue;
                //     }
                // }
                let id = intention.predicate[1]
                    let p = parcels.get(id)
                    if(p && p.carriedBy){
                        console.log( 'Skipping intention because no more valid', intention.predicate );
                        continue;
                    }

                await intention.achieve().catch( err => {})

                this.intention_queue.shift();
            }

            await new Promise( res => setImmediate(res) );
        }
    }

    log ( ...args ) {
        console.log( ...args )
    }

    async push ( predicate ) {

        const last = this.intention_queue.at(this.intention_queue.length - 1)
        if (last && last.predicate.join(' ') == predicate.join(' ')) {
            return;
        }

        console.log( 'IntentionRevision.push', predicate );
        const intention = new Intention ( this, predicate );
        this.intention_queue.push( intention );

        if (last) {
            last.stop();
        }

    }
}

const myAgent = new IntentionRevision();
myAgent.loop();

class Intention {

    #current_plan;

    #stopped = false;
    get stopped () {
        return this.#stopped;
    }

    #parent;

    get predicate () {
        return this.#predicate;
    }

    #predicate;

    constructor (parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    log (...args) {
        if (this.#parent && this.#parent.log)
            this.#parent.log('\t', ...args);
        else
            console.log(...args);
    }

    #started = false;

    async achieve() {

        if (this.#started)
            return this;
        else
            this.#started = true;

            for (const planClass of planLibrary) {
                if (this.stopped) throw ['stopped intention', ...this.predicate];

                if (planClass.isApplicableTo(...this.predicate)) {
                    this.#current_plan = new planClass(this.#parent);
                    this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);

                    try {
                        const plan_res = await this.#current_plan.execute( ...this.predicate);
                        this.log( 'succesful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', plan_res );
                        return plan_res;
                    }
                    catch (err) {
                        this.log( 'failed intention', ...this.predicate,'with plan', planClass.name, 'with error:', err );
                    }
                }
            }

            if ( this.stopped ) throw [ 'stopped intention', ...this.predicate ];

            throw ['no plan satisfied the intention ', ...this.predicate ]
    }
}

const planLibrary = [];

class Plan {

    #stopped = false;
    stop() {
        this.#stopped = true;
        for ( const i of this.#sub_intentions ) {
            i.stop();
        }
    }
    get stopped () {
        return this.#stopped;
    }

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

    static isApplicableTo ( go_deliver, x, y, id ) {
        return go_deliver == 'go_deliver';
    }

    async execute ( go_pick_up, x, y ) {
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

// plan classes are added to plan library 
planLibrary.push( GoPickUp )
planLibrary.push( GoDeliver )
planLibrary.push( BlindMove )
