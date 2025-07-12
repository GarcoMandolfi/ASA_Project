import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { PddlDomain, PddlAction, PddlProblem, PddlExecutor, onlineSolver, Beliefset } from "@unitn-asa/pddl-client";
import * as utils from "./planningUtils.js"

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

let config = {};
const pddlBeliefSet = new Beliefset();
const moveRight = new PddlAction(
    'moveRight',
    '?A ?B',
    'and (at ?A) (traversable ?B) (right ?B ?A)',
    'and (at ?B) (not (at ?A))',
    // async () => await client.emitMove('right')
    async () => console.log("RIGHT")
);
const moveLeft = new PddlAction(
    'moveLeft',
    '?A ?B',
    'and (at ?A) (traversable ?B) (left ?B ?A)',
    'and (at ?B) (not (at ?A))',
    // async () => await client.emitMove('left')
    async () => console.log("LEFT")
);
const moveUp = new PddlAction(
    'moveUp',
    '?A ?B',
    'and (at ?A) (traversable ?B) (up ?B ?A)',
    'and (at ?B) (not (at ?A))',
    // async () => await client.emitMove('up')
    async () => console.log("UP")
);
const moveDown = new PddlAction(
    'moveDown',
    '?A ?B',
    'and (at ?A) (traversable ?B) (up ?A ?B)',
    'and (at ?B) (not (at ?A))',
    // async () => await client.emitMove('down')
    async () => console.log("DOWN")
);
// @ts-ignore
const pddlDomain = new PddlDomain( 'Deliveroo', moveRight, moveLeft, moveUp, moveDown );
pddlDomain.addPredicate('at ?A');
pddlDomain.addPredicate('traversable ?A');
pddlDomain.addPredicate('up ?A ?B');
pddlDomain.addPredicate('down ?A ?B');
pddlDomain.addPredicate('right ?A ?B');
pddlDomain.addPredicate('left ?A ?B');

console.log(pddlDomain.toPddlString());


client.onConfig(cfg => {
    
    config = {
        ...cfg,
        PARCEL_DECADING_INTERVAL: utils.parseDecayInterval(cfg.PARCEL_DECADING_INTERVAL)
        
    }

    console.log(config);

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
export {pddlBeliefSet}

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
    if (!isFinite(config.PARCEL_DECADING_INTERVAL)) return;

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
        
        // Block new positions
        utils.blockAgentPositions(a.id, occupiedCells);
    }
    
    // Check all tracked agents for visibility
    for (let [agentId, agent] of otherAgents) {
        const distance = Math.abs(agent.x - me.x) + Math.abs(agent.y - me.y);
        const canSeeAgent = distance < config.AGENTS_OBSERVATION_DISTANCE;
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
        if (utils.manhattanDistance({ x: parcel.x, y: parcel.y }, me) < config.PARCELS_OBSERVATION_DISTANCE && !pp.find(p => p.id === parcel.id))
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
        if (
            Number.isInteger(me.x) && Number.isInteger(me.y) &&
            Number.isInteger(parcel.x) && Number.isInteger(parcel.y)
        ) {
            const pickupPath = utils.getShortestPath(me.x, me.y, parcel.x, parcel.y);
            if (pickupPath && pickupPath.cost < best_distance) {
                best_distance = pickupPath.cost;
                best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, pickupPath.path];
            }
        }
    }
    // Push the best option found
    if (best_option !== null && best_distance !== null) {
        myAgent.push(best_option);
    }
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

let [prevX, prevY] = [undefined, undefined];

class IntentionRevision {

    #intention_queue = new Array();
    get intention_queue () {
        return this.#intention_queue;
    }

    async loop ( ) {
        await new Promise(res => setTimeout(res, 50));

        while ( true ) {
            // Consumes intention_queue if not empty
            if ( this.intention_queue.length > 0 ) {
            
                // Current intention
                const intention = this.intention_queue[0];
                
                // Is queued intention still valid? Do I still want to achieve it?
                // TODO this hard-coded implementation is an example
                let id = intention.predicate[2]
                let p = freeParcels.get(id)
                if ( !utils.stillValid(intention.predicate) ) {
                    this.intention_queue.shift();
                    continue;
                }

                // Start achieving intention
                await intention.achieve()
                // Catch eventual error and continue
                .catch( error => {
                } );

                // Remove from the queue
                this.intention_queue.shift();
            }
            else {
                generateOptions();
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

        if(!Number.isInteger(me.x) || !Number.isInteger(me.y)) return;

        // Find existing index with same id (only for go_pick_up)
        // Check if already queued
        const last = this.intention_queue[this.intention_queue.length - 1];
        
        if ( last && last.predicate.slice(0, 3).join(' ') == predicate.slice(0, 3).join(' ') ) {
            return; // intention is already being achieved
        }

        // Check if there is already an intention with the same first 4 elements
        if (this.intention_queue.some(i =>
            i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ')
        )) {
            return;
        }

        // This is a reference to the actual object in the queue, not a copy
        let existingIntention = this.intention_queue.find(i => {
            return i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ');
        });
        if (existingIntention && existingIntention.predicate[0] != "idle")
            existingIntention.updateIntention(predicate);
        
        const intention = new Intention( this, predicate );
        this.intention_queue.push( intention );
        let i = intention.predicate;

        // Sort by score descending
        this.intention_queue.sort((a, b) => {
            let result  =  utils.getScore(b.predicate) - utils.getScore(a.predicate);
            return result;
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

    updateIntention(predicate) {

        switch(predicate[0]){
            case "go_pick_up":
                this.predicate[4] = predicate[4];
                break;
            case "go_deliver":
                this.predicate[3] = predicate[3];
                break;
            default:
                return false;
        }

        return true;
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

    static isApplicableTo ( go_pick_up, x, y, id, path ) {
        return go_pick_up == 'go_pick_up';
    }

    async execute ( go_pick_up, x, y, id, path ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y, path] );
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
        await this.subIntention( ['pddl_move', x, y]);
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

class PddlMove extends Plan {

    static isApplicableTo(pddl_move) {
        return pddl_move == 'pddl_move';
    }

    async execute(pddl_move, x, y) {
        if (this.stopped) throw ['stopped'];
        [prevX, prevY] = utils.updateBeliefPosition(prevX, prevY);

        let pddlProblem = new PddlProblem(
            'Deliveroo',
            pddlBeliefSet.objects.join(' '),
            pddlBeliefSet.toPddlString(),
            'and (at Tile_' + x + '_' + y + ') (not (at Tile_' + me.x + '_' + me.y + '))'
        );

        console.log(pddlProblem.toPddlString());

        let plan = await onlineSolver(pddlDomain.toPddlString(), pddlProblem.toPddlString());
        console.log("I BUILT A PLAN " + plan);
        return true;
    }

}

class IdleMove extends Plan {

    static directions = ['up', 'right', 'down', 'left'];
    static LastDir = Math.floor(Math.random() * IdleMove.directions.length);
    static _prevCell = null;

    static isApplicableTo(idle) {
        return idle == 'idle';
    }

    async execute(go_to) {
        if (this.stopped) throw ['stopped'];

        let inObsRange = false;
        for (const tile of generatingCells.values()) {
            if (utils.manhattanDistance({x: me.x, y: me.y}, {x: tile.x, y: tile.y}) <= config.PARCELS_OBSERVATION_DISTANCE) {
                inObsRange = true;
                break;
            }
        }
        if (generatingCells.size > 0 && !inObsRange) {
            let closestTile = undefined;
            let shortestPath = undefined;

            for (const tile of generatingCells.values()) {
                const path = utils.getShortestPath(me.x, me.y, tile.x, tile.y).path; // Replace with your actual pathfinding
                if (path && (!shortestPath || path.length < shortestPath.length)) {
                    shortestPath = path;
                    closestTile = tile;
                }
            }

            if (shortestPath) {
                await this.subIntention( ['go_to', closestTile.x, closestTile.y, shortestPath] );
            }
        }
        else{

            const x = me.x;
            const y = me.y;
            const currentNodeId = '(' + x + ',' + y + ')';
            const prevCell = IdleMove._prevCell;
            let foundMove = false;
            let skippedPrev = null;

            // Shuffle directions for equal chance
            const dirs = IdleMove.directions.slice();
            for (let i = dirs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
            }

            // Try all directions, skipping previous cell if possible
            for (const dir of dirs) {
                let [targetX, targetY] = [x, y];
                if (dir === 'up') targetY++;
                else if (dir === 'down') targetY--;
                else if (dir === 'left') targetX--;
                else if (dir === 'right') targetX++;
                const targetNodeId = '(' + targetX + ',' + targetY + ')';
                if (
                    global.graph &&
                    global.graph.has(currentNodeId) &&
                    global.graph.has(targetNodeId) &&
                    global.graph.get(currentNodeId).has(targetNodeId)
                ) {
                    if (prevCell && targetNodeId === prevCell) {
                        skippedPrev = { dir, targetX, targetY, targetNodeId };
                        continue;
                    }
                    let moveResult = null;
                    switch (dir) {
                        case 'up': moveResult = await client.emitMove('up'); break;
                        case 'down': moveResult = await client.emitMove('down'); break;
                        case 'left': moveResult = await client.emitMove('left'); break;
                        case 'right': moveResult = await client.emitMove('right'); break;
                    }
                    if (moveResult) {
                        IdleMove.LastDir = IdleMove.directions.indexOf(dir);
                        IdleMove._prevCell = currentNodeId;
                        foundMove = true;
                        break;
                    }
                }
            }

            // If no move found and we skipped the previous cell, try it now
            if (!foundMove && skippedPrev) {
                const { dir, targetNodeId } = skippedPrev;
                let moveResult = null;
                switch (dir) {
                    case 'up': moveResult = await client.emitMove('up'); break;
                    case 'down': moveResult = await client.emitMove('down'); break;
                    case 'left': moveResult = await client.emitMove('left'); break;
                    case 'right': moveResult = await client.emitMove('right'); break;
                }
                if (moveResult) {
                    IdleMove.LastDir = IdleMove.directions.indexOf(dir);
                    IdleMove._prevCell = currentNodeId;
                    foundMove = true;
                }
            }

            if (!foundMove) {
                // No valid move found, remain idle
                IdleMove.LastDir = (IdleMove.LastDir + 1) % 4;
                IdleMove._prevCell = null;
            }
        }

        return true;
    }
}

// plan classes are added to plan library 
planLibrary.push( GoPickUp )
planLibrary.push( GoDeliver )
planLibrary.push( BlindMove )
planLibrary.push( IdleMove )
planLibrary.push( PddlMove )