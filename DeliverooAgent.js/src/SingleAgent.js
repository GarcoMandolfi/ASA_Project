import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import * as utils from "./utils.js"

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

// let DECAY_INTERVAL = 0;
// let OBS_RANGE = 0;
// let MOVE_DURATION = 0;
// let MOVE_STEPS = 0;
// let MAX_PARCELS = 0;
// let AGENT_OBS_RANGE = 0;
// let CLOCK = 0;

let config = {};



client.onConfig(cfg => {
    
    config = {
        ...cfg,
        DECAY_INTERVAL: utils.parseDecayInterval
    }

});

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: null, name: null, x: null, y: null, score: null};

/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, lastUpdate:number} > }
 */
const freeParcels = new Map();
// #######################################################################################################################
// CHECK CARRIED BY
//##########################################################################################################################

// CHECK ID CONSISTENCY
/**
 * @type { Map< string, {id: string, reward:number, lastUpdate:number} > }
 */
const carriedParcels = new Map();

/**
 * @type { Map< string, {id: string, x:number, y:number, lastUpdate:number, isMoving:boolean, direction:string, occupiedCells:Array<String>, status:string } > }
 */
const otherAgents = new Map();

/**
 * @type { Map< string, {x:number, y:number, type:Number} > }
 */
const deliveryCells = new Map();

/**
 * @type { Map< string, {x:number, y:number, type:Number} > }
 */
const generatingCells = new Map();

export {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells}

client.onMap((width, height, tiles) => {
    deliveryCells.clear();

    const tiles2D = utils.createTiles2D(width, height, tiles);
    const { graph, nodePositions } = utils.createGraphFromTiles(width, height, tiles2D);

    global.graph = graph;
    global.nodePositions = nodePositions;
    global.mapWidth = width;
    global.mapHeight = height;
    global.tiles2D = tiles2D;

})

client.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score

    if (global.graph && Number.isInteger(me.x) && Number.isInteger(me.y)) {
        utils.findClosestDelivery(me.x, me.y);
    }
} )

setInterval(() => {
    if (!isFinite(config.DECAY_INTERVAL)) return;

    utils.decayParcels();

}, 1000);


client.onAgentsSensing(agents => {
    const seenAgentIds = new Set();
    
    for (let a of agents) {
        seenAgentIds.add(a.id);
        
        // Skip our own agent
        if (a.id === me.id) continue;
        

        
        const isMoving = !Number.isInteger(a.x) || !Number.isInteger(a.y);
        const direction = utils.getAgentDirection(a);
        const occupiedCells = utils.getAgentOccupiedCells(a);
        
        // Check if this is a new agent or if position has changed
        const existingAgent = otherAgents.get(a.id);
        const positionChanged = !existingAgent || 
                              existingAgent.x !== a.x || 
                              existingAgent.y !== a.y;
        
        if (existingAgent && positionChanged) {
            // Agent moved to a different position - unblock previous positions
            if (existingAgent.occupiedCells) {
                utils.unblockAgentPositions(a.id, existingAgent.occupiedCells);
            }
        }
        
        // Update or add agent information
        otherAgents.set(a.id, {
            id : a.id,
            x: a.x,
            y: a.y,
            lastUpdate: Date.now(),
            isMoving: isMoving,
            direction: direction,
            occupiedCells: occupiedCells,
            status: 'visible'
        });
        
        // Block new positions only if agent is visible
        if (utils.isAgentInRange(a.x, a.y, me.x, me.y)) {
            utils.blockAgentPositions(a.id, occupiedCells);
        }
    }
    
    // Check all tracked agents for visibility
    for (let [agentId, agent] of otherAgents) {
        const distance = Math.abs(agent.x - me.x) + Math.abs(agent.y - me.y);
        const canSeeAgent = distance < config.AGENT_OBS_RANGE;
        const agentIsVisible = seenAgentIds.has(agentId);
        
        if (canSeeAgent) {
            if (agentIsVisible) {
                // Agent is visible - update last seen
                agent.lastUpdate = Date.now();
                agent.status = 'visible';
                otherAgents.set(agentId, agent);
            } else {
                // Can see the position but agent is not there - position is empty
                agent.status = 'unknown';
                agent.lastUpdate = Date.now();
                otherAgents.set(agentId, agent);
                
                // Unblock the position since it's empty
                if (agent.occupiedCells) {
                    utils.unblockAgentPositions(agentId, agent.occupiedCells);
                }
            }
        } else {
            // Can't see the agent's position - mark as out of range but keep position
            if (agent.status === 'visible') {
                agent.status = 'out_of_range';
                agent.lastUpdate = Date.now();
                otherAgents.set(agentId, agent);
                // Don't unblock position - we're keeping it as potentially occupied
            }
        }
    }
});


client.onParcelsSensing( async (pp) => {
    carriedParcels.clear();

    for (const [id, parcel] of freeParcels) {
        if (utils.manhattanDistance({ x: parcel.x, y: parcel.y }, me) < config.OBS_RANGE && !pp.find(p => p.id === parcel.id))
            freeParcels.delete(id);
    }

    for (const p of pp) {
        if (p.carriedBy === me.id && !carriedParcels.has(p.id)) {
            freeParcels.delete(p.id);
            carriedParcels.set(p.id, {id:p.id, reward:p.reward, lastUpdate:Date.now()});
        }
        else if (p.carriedBy === null)
            utils.parcelUpdate(p);
        else
            freeParcels.delete(p.id);
    }
});

// ###################################################################################################
// OPTIONS GENERATION AND FILTERING
// ###################################################################################################

function generateOptions () {

    const carriedTotal = utils.carriedValue();

    let best_option = null;
    let best_distance = Number.MAX_VALUE;

    // Check delivery option if carrying valuable parcels
    if (carriedTotal != 0) {
        const bestDelivery = utils.findClosestDelivery(me.x, me.y);
        if (bestDelivery) {
            best_option = ['go_deliver', bestDelivery.deliveryPoint.x, bestDelivery.deliveryPoint.y, bestDelivery.path];
            best_distance = bestDelivery.distance;
        }
    }

    // Always consider pickup options too, and pick nearest
    for (const parcel of freeParcels.values()) {
        if (!parcel.carriedBy) {
            const d = utils.manhattanDistance(me, {x: parcel.x, y: parcel.y});
            if (d < best_distance) {
                best_distance = d;
                best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, parcel.reward, parcel.lastUpdate];
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


client.onParcelsSensing( generateOptions )
client.onAgentsSensing( generateOptions )
client.onYou( generateOptions )


// ###################################################################################################
// INTENTION REVISION
// ###################################################################################################


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
                let p = freeParcels.get(id)
                if ( !utils.stillValid(intention.predicate) ) {
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
            return utils.getScore(b.predicate) - utils.getScore(a.predicate);
        });

        // Stop current if not at top
        if (last) {
            last.stop();
        }
    }
}


const myAgent = new IntentionRevision();
myAgent.loop();


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

    static isApplicableTo ( go_deliver, x, y, path ) {
        return go_deliver == 'go_deliver';
    }

    async execute ( go_deliver, x, y, path ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y, path] );
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await client.emitPutdown()
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        return true;
    }

}

class BlindMove extends Plan {

    static isApplicableTo ( go_to, x, y, path ) {
        return go_to == 'go_to';
    }

    async execute ( go_to, x, y, path ) {
        if (path && Array.isArray(path) && path.length > 1) {
            // path is an array of node strings like '(x,y)'
            for (let i = 1; i < path.length; i++) {
                if (this.stopped) throw ['stopped'];
                const [targetX, targetY] = path[i].replace(/[()]/g, '').split(',').map(Number);
                const dx = targetX - me.x;
                const dy = targetY - me.y;
                let moved = null;
                if (dx > 0) moved = await client.emitMove('right');
                else if (dx < 0) moved = await client.emitMove('left');
                else if (dy > 0) moved = await client.emitMove('up');
                else if (dy < 0) moved = await client.emitMove('down');
                if (moved) {
                    me.x = moved.x;
                    me.y = moved.y;
                } else {
                    this.log('stucked');
                    throw 'stucked';
                }
            }
            return true;
        }
    }
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
                if (utils.isFree(x, y + 1))
                    moved = await client.emitMove('up');
                break;
            case 'down':
                if (utils.isFree(x, y - 1))
                    moved = await client.emitMove('down');
                break;
            case 'left':
                if (utils.isFree(x - 1, y))
                    moved = await client.emitMove('left');
                break;
            case 'right':
                if (utils.isFree(x + 1, y))
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


async function goToBestDeliveryPoint() {
    console.log('Starting navigation to best delivery point...');
    
    if (!global.graph) {
        console.log('Graph not ready yet. Please wait for map to load.');
        return;
    }
    
    let bestDelivery = utils.findClosestDelivery(me.x, me.y);
    
    if (!bestDelivery) {
        console.log('No reachable delivery points found.');
        return;
    }
    
    console.log(`\nNavigating to delivery point at (${bestDelivery.deliveryPoint.x}, ${bestDelivery.deliveryPoint.y})`);
    console.log(`Total distance: ${bestDelivery.distance} steps`);
    
    // Follow the complete path step by step
    for (let i = 1; i < bestDelivery.path.length; i++) {
        // Check if current path is still valid before each move
        if (!utils.isPathValid(bestDelivery.path)) {
            console.log('⚠️ Path blocked! Recalculating best path...');
            bestDelivery = utils.findClosestDelivery(me.x, me.y);
            
            if (!bestDelivery) {
                console.log('❌ No valid path found after recalculation. Stopping navigation.');
                return;
            }
            
            // Restart from current position with new path
            i = 0; // Start from beginning of new path
            continue;
        }
        
        const currentStep = bestDelivery.path[i];
        const [targetX, targetY] = currentStep.split(',').map(Number);
        
        // Calculate direction from current position to target
        const dx = targetX - me.x;
        const dy = targetY - me.y;
        
        if (dx > 0) {
            await client.emitMove('right');
        } else if (dx < 0) {
            await client.emitMove('left');
        } else if (dy > 0) {
            await client.emitMove('up');
        } else if (dy < 0) {
            await client.emitMove('down');
        } else {
            continue;
        }
        
        // Wait for the move to complete and position to update
        // Use just the clock value for faster movement
        await new Promise(resolve => setTimeout(resolve, config.CLOCK));
    }
}

// Set up terminal input listener
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
    const command = data.toString().trim().toLowerCase();
    
    if (command === 'go') {
        goToBestDeliveryPoint();
    } else if (command === 'help') {
        console.log('\nAvailable commands:');
        console.log('  go    - Navigate to best delivery point');
        console.log('  help  - Show this help message');
        console.log('  quit  - Exit the program');
    } else if (command === 'quit') {
        console.log('Exiting...');
        process.exit(0);
    } else {
        console.log(`Unknown command: ${command}. Type 'help' for available commands.`);
    }
});

console.log('\n🚀 Agent ready! Type "go" to navigate to best delivery point.');
console.log('Type "help" for available commands.');