import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import { PddlDomain, PddlAction, PddlProblem, PddlExecutor, onlineSolver, Beliefset } from "@unitn-asa/pddl-client";
import * as utils from "./planningUtils.js"
import readline from 'readline';

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

// Pause/Resume functionality
let isPaused = false;
let pauseResumePromise = null;
let pauseResumeResolver = null;

// Delivery state management
let justDelivered = false;
let lastDeliveryTime = 0;

// Setup keyboard listener for pause/resume
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

process.stdin.on('keypress', (str, key) => {
    if (key.name === 'p' && !isPaused) {
        console.log('\nProgram PAUSED. Press "r" to resume...');
        isPaused = true;
        pauseResumePromise = new Promise(resolve => {
            pauseResumeResolver = resolve;
        });
    } else if (key.name === 'r' && isPaused) {
        console.log('Program RESUMED.');
        isPaused = false;
        if (pauseResumeResolver) {
            pauseResumeResolver();
            pauseResumeResolver = null;
        }
    } else if (key.ctrl && key.name === 'c') {
        console.log('\nProgram terminated.');
        process.exit();
    }
});

// Helper function to check pause state
async function checkPause() {
    if (isPaused && pauseResumePromise) {
        await pauseResumePromise;
    }
}

let config = {};
const pddlBeliefSet = new Beliefset();
const moveRight = new PddlAction(
    'moveRight',
    '?A ?B',
    'and (tile ?A) (tile ?B) (at ?A) (traversable ?B) (right ?B ?A)',
    'and (at ?B) (not (at ?A))',
    async () => await client.emitMove('right')
);
const moveLeft = new PddlAction(
    'moveLeft',
    '?A ?B',
    'and (tile ?A) (tile ?B) (at ?A) (traversable ?B) (left ?B ?A)',
    'and (at ?B) (not (at ?A))',
    async () => await client.emitMove('left')
);
const moveUp = new PddlAction(
    'moveUp',
    '?A ?B',
    'and (tile ?A) (tile ?B) (at ?A) (traversable ?B) (up ?B ?A)',
    'and (at ?B) (not (at ?A))',
    async () => await client.emitMove('up')
);
const moveDown = new PddlAction(
    'moveDown',
    '?A ?B',
    'and (tile ?A) (tile ?B) (at ?A) (traversable ?B) (down ?B ?A)',
    'and (at ?B) (not (at ?A))',
    async () => await client.emitMove('down')
);
const putDown = new PddlAction(
    'putDown',
    '?A',
    'and (tile ?A) (at ?A) (delivery ?A) (canDeliver)',
    'not (canDeliver)',
    async () => await client.emitPutdown()
);
// @ts-ignore
const pddlDomain = new PddlDomain( 'Deliveroo', moveRight, moveLeft, moveUp, moveDown, putDown );
pddlDomain.addPredicate('tile ?A');
pddlDomain.addPredicate('delivery ?A');
pddlDomain.addPredicate('at ?A');
pddlDomain.addPredicate('traversable ?A');
pddlDomain.addPredicate('up ?B ?A');
pddlDomain.addPredicate('down ?B ?A');
pddlDomain.addPredicate('right ?B ?A');
pddlDomain.addPredicate('left ?B ?A');
pddlDomain.addPredicate('canDeliver');


const pddlExecutor = new PddlExecutor(
    {name: 'moveRight', executor: async () => await client.emitMove('right')},
    {name: 'moveLeft', executor: async () => await client.emitMove('left')},
    {name: 'moveUp', executor: async () => await client.emitMove('up')},
    {name: 'moveDown', executor: async () => await client.emitMove('down')},
    {name: 'putDown', executor: async () => await client.emitPutdown()});


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


/**
 * @type { Array<{id: string, x: number, y: number, generatingCellsNearby: number, lastSeen: number}> }
 */
const candidates = [];

export {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells, candidates}
export {pddlBeliefSet, pddlDomain}

client.onMap((width, height, tiles) => {
    deliveryCells.clear();

    const tiles2D = utils.createTiles2D(width, height, tiles);
    const { graph, nodePositions } = utils.createGraphFromTiles(width, height, tiles2D);

    global.graph = graph;
    global.nodePositions = nodePositions;
    global.mapWidth = width;
    global.mapHeight = height;
    global.tiles2D = tiles2D;
    makeCandidates();

})

function makeCandidates() {
    if (!global.graph || !global.nodePositions) {
        console.log('Graph not ready for candidate generation');
        return;
    }

    const parcelObsDistance = config.PARCELS_OBSERVATION_DISTANCE || 5;
    const allCells = [];
    const processedCells = new Set(); // Track processed generating cells
    
    // Analyze each generating cell (green cell) only
    for (const [nodeId, position] of global.nodePositions) {
        const { x, y } = position;
        
        // Only consider generating cells as candidates
        const isGeneratingCell = generatingCells.has(nodeId);
        if (!isGeneratingCell) continue;
        
        // Skip if already processed (directly connected to a previous cell)
        if (processedCells.has(nodeId)) continue;
        
        let generatingCellsNearby = 0;
        const directlyConnectedGeneratingCells = new Set(); // Track cells connected without grey cells
        
        // Check all other generating cells to see if they're within observation distance
        for (const [otherNodeId, otherPosition] of global.nodePositions) {
            if (nodeId === otherNodeId) continue;
            
            // Check if the other cell is also a generating cell
            const isOtherGeneratingCell = generatingCells.has(otherNodeId);
            if (!isOtherGeneratingCell) continue;
            
            // Calculate shortest path distance
            const pathResult = utils.getShortestPath(x, y, otherPosition.x, otherPosition.y);
            if (pathResult && pathResult.cost !== null && pathResult.cost <= parcelObsDistance) {
                generatingCellsNearby++;
                
                // Check if this cell is directly connected (path length = 1, no grey cells in between)
                if (pathResult.path) {
                    // Check if the path contains only generating cells (no grey cells)
                    let hasOnlyGeneratingCells = true;
                    for (const pathNodeId of pathResult.path) {
                        if (!generatingCells.has(pathNodeId)) {
                            hasOnlyGeneratingCells = false;
                            break;
                        }
                    }
                    if (hasOnlyGeneratingCells) {
                        directlyConnectedGeneratingCells.add(otherNodeId);
                    }
                }
            }
        }
        
        // Add generating cell to list
        allCells.push({
            id: nodeId,
            x: x,
            y: y,
            generatingCellsNearby: generatingCellsNearby,
            lastSeen: Date.now()
        });
        
        // Mark directly connected generating cells as processed to avoid redundant calculations
        processedCells.add(nodeId);
        for (const connectedCellId of directlyConnectedGeneratingCells) {
            processedCells.add(connectedCellId);
        }
    }
    
    // Sort by number of generating cells nearby (descending)
    allCells.sort((a, b) => b.generatingCellsNearby - a.generatingCellsNearby);
    
    // Select top 3 candidates that are farthest from each other
    const selectedCandidates = [];
    
    if (allCells.length > 0) {
        // Select first candidate (highest score)
        selectedCandidates.push(allCells[0]);
        
        if (allCells.length > 1) {
            // Select second candidate: farthest from the first
            let maxDistance = 0;
            let secondCandidate = null;
            
            for (let i = 1; i < allCells.length; i++) {
                const distance = utils.manhattanDistance(
                    { x: allCells[i].x, y: allCells[i].y },
                    { x: selectedCandidates[0].x, y: selectedCandidates[0].y }
                );
                if (distance > maxDistance) {
                    maxDistance = distance;
                    secondCandidate = allCells[i];
                }
            }
            
            if (secondCandidate) {
                selectedCandidates.push(secondCandidate);
            }
            
            if (allCells.length > 2) {
                // Select third candidate: farthest from both first and second
                maxDistance = 0;
                let thirdCandidate = null;
                
                for (let i = 1; i < allCells.length; i++) {
                    const cell = allCells[i];
                    if (cell === secondCandidate) continue; // Skip already selected
                    
                    // Calculate minimum distance to both selected candidates
                    const distanceToFirst = utils.manhattanDistance(
                        { x: cell.x, y: cell.y },
                        { x: selectedCandidates[0].x, y: selectedCandidates[0].y }
                    );
                    const distanceToSecond = utils.manhattanDistance(
                        { x: cell.x, y: cell.y },
                        { x: selectedCandidates[1].x, y: selectedCandidates[1].y }
                    );
                    const minDistance = Math.min(distanceToFirst, distanceToSecond);
                    
                    if (minDistance > maxDistance) {
                        maxDistance = minDistance;
                        thirdCandidate = cell;
                    }
                }
                
                if (thirdCandidate) {
                    selectedCandidates.push(thirdCandidate);
                }
            }
        }
    }
    
    // Update the global candidates list
    candidates.length = 0; // Clear existing candidates
    candidates.push(...selectedCandidates);
    if (candidates.length > 0) {
        while (candidates.length < 3) {
            candidates.push(candidates[0]);
        }   
    }
    
    console.log('Generated candidates:', candidates.map(c => 
        `${c.id} (${c.x},${c.y}) with ${c.generatingCellsNearby} generating cells nearby`
    ));
}

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


client.onAgentsSensing(async agents => {
    await checkPause();
    
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
        
        // Block new positions only if agent is visible and in range
        const distance = Math.abs(a.x - me.x) + Math.abs(a.y - me.y);
        if (distance < config.AGENTS_OBSERVATION_DISTANCE) {
            utils.blockAgentPositions(a.id, occupiedCells);
        }
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
    await checkPause();
    
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

// Helper function to validate if a path is still valid
function isPathValid(path) {
    if (!path || !Array.isArray(path) || path.length === 0) {
        console.log('Path validation failed: path is null, not array, or empty');
        return false;
    }
    
    console.log(`Validating path: ${path.join(' -> ')}`);
    for (let nodeId of path) {
        if (!global.graph || !global.graph.has(nodeId)) {
            console.log(`Path validation failed: node ${nodeId} not found in graph`);
            return false;
        }
    }
    console.log('Path validation passed');
    return true;
}

function generateOptions () {
    // Check if we just delivered and should wait before generating new options
    const timeSinceDelivery = Date.now() - lastDeliveryTime;
    if (justDelivered && timeSinceDelivery < 2000) { // Wait 2 seconds after delivery
        console.log('Just delivered, waiting before generating new options');
        return;
    }
    
    // Reset delivery flag if enough time has passed
    if (justDelivered && timeSinceDelivery >= 2000) {
        justDelivered = false;
    }
    
    const carriedTotal = utils.carriedValue();

    let best_option = null;
    let best_distance = Number.MAX_VALUE;

    // Check delivery option if carrying valuable parcels
    if (carriedTotal != 0) {
        const bestDelivery = utils.findClosestDelivery(me.x, me.y);
        if (bestDelivery && bestDelivery.deliveryPoint&& isPathValid(bestDelivery.path)) {
            console.log(`Found delivery point at (${bestDelivery.deliveryPoint.x}, ${bestDelivery.deliveryPoint.y})`);
            console.log(`Delivery path: ${bestDelivery.path.join(' -> ')}`);
            best_option = ['go_deliver', bestDelivery.deliveryPoint.x, bestDelivery.deliveryPoint.y, bestDelivery.path];
            best_distance = bestDelivery.distance;
        } else {
            console.log('No valid delivery point found or path is invalid');
        }
    }

    // Always consider pickup options too, and pick nearest
    for (const parcel of freeParcels.values()) {
        if (
            Number.isInteger(me.x) && Number.isInteger(me.y) &&
            Number.isInteger(parcel.x) && Number.isInteger(parcel.y)
        ) {
            const pickupPath = utils.getShortestPath(me.x, me.y, parcel.x, parcel.y);
            if (pickupPath && pickupPath.path && pickupPath.cost < best_distance && isPathValid(pickupPath.path)) {
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
            // Check for pause
            await checkPause();

            if (carriedParcels.size == 0)
                pddlBeliefSet.undeclare('canDeliver');
            else
                pddlBeliefSet.declare('canDeliver');

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

console.log('\n🎮 Pause/Resume Controls:');
console.log('   Press "p" to PAUSE the program');
console.log('   Press "r" to RESUME the program');
console.log('   Press "Ctrl+C" to exit\n');

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
        
        // Check if we're at the correct position for pickup
        if (me.x == x && me.y == y) {
            // Add a small delay before pickup to ensure we're properly positioned
            await new Promise(resolve => setTimeout(resolve, 100));
            await client.emitPickup();

            return true;
        } else {
            throw ['Not at pickup location'];
        }
    }

}

class GoDeliver extends Plan {

    static isApplicableTo ( go_deliver, x, y, path ) {
        return go_deliver == 'go_deliver';
    }

    async execute ( go_deliver, x, y, path ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        
        // Try PDDL delivery first
        try {
            this.log('Using PDDL delivery');
            await this.subIntention( ['pddl_deliver', x, y]);
            // Add a longer delay after successful delivery to prevent immediate movement
            await new Promise(resolve => setTimeout(resolve, 100));
            
            return true;
        } catch (error) {
            this.log('PDDL delivery failed, trying path-based delivery as fallback');
            // Fallback: use path-based delivery
            await this.subIntention( ['go_to', x, y, path] );
            await this.subIntention( ['simple_deliver', x, y] );
            // Add a longer delay after successful delivery to prevent immediate movement
            await new Promise(resolve => setTimeout(resolve, 100));
                        
            return true;
        }
    }

}

class BlindMove extends Plan {

    static isApplicableTo ( go_to, x, y, path ) {
        return go_to == 'go_to';
    }

    async execute ( go_to, x, y, path ) {
        if (path && Array.isArray(path) && path.length > 1) {
            this.log(`Starting movement to (${x}, ${y}) with path: ${path.join(' -> ')}`);
            this.log(`Current position: (${me.x}, ${me.y})`);
            
            // path is an array of node strings like '(x,y)'
            for (let i = 1; i < path.length; i++) {
                if (this.stopped) throw ['stopped'];
                
                const [targetX, targetY] = path[i].replace(/[()]/g, '').split(',').map(Number);
                const dx = targetX - me.x;
                const dy = targetY - me.y;
                
                // Check if target position is blocked by another agent
                let targetBlocked = false;
                for (const [agentId, agent] of otherAgents) {
                    if (agent.status === 'visible' && agent.x == targetX && agent.y == targetY) {
                        targetBlocked = true;
                        break;
                    }
                }
                
                // Also check if the target position is blocked in the graph
                const targetNodeId = `(${targetX},${targetY})`;
                if (global.graph && !global.graph.has(targetNodeId)) {
                    this.log(`Target position (${targetX}, ${targetY}) blocked in graph`);
                    targetBlocked = true;
                    
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // If we've been stuck for too long, recalculate the path
                    if (i > 1) {
                        this.log('Stuck for too long, recalculating path...');
                        throw ['path_blocked'];
                    }
                    continue; // Try the same step again
                }
                
                // Check if the target position is actually reachable
                if (global.graph) {
                    const currentNodeId = `(${Math.floor(me.x)},${Math.floor(me.y)})`;
                    const targetNodeId = `(${targetX},${targetY})`;
                    
                    if (!global.graph.has(currentNodeId) || !global.graph.has(targetNodeId)) {
                        throw ['current_position_invalid'];
                    }
                    
                    const currentNeighbors = global.graph.get(currentNodeId);
                    if (!currentNeighbors || !currentNeighbors.has(targetNodeId)) {
                        this.log(`No direct path from ${currentNodeId} to ${targetNodeId}`);
                        throw ['no_direct_path'];
                    }
                }
                
                let moved = null;
                if (dx > 0) moved = await client.emitMove('right');
                else if (dx < 0) moved = await client.emitMove('left');
                else if (dy > 0) moved = await client.emitMove('up');
                else if (dy < 0) moved = await client.emitMove('down');
                
                if (moved) {
                    me.x = moved.x;
                    me.y = moved.y;
                    this.log(`Successfully moved to (${me.x}, ${me.y})`);
                } else {
                    this.log('stucked');
                    
                    // Try to find an alternative path or wait a bit
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // Check if we can move in any direction
                    const directions = ['up', 'down', 'left', 'right'];
                    let foundAlternative = false;
                    
                    for (const dir of directions) {
                        let testMove = null;
                        switch (dir) {
                            case 'up': testMove = await client.emitMove('up'); break;
                            case 'down': testMove = await client.emitMove('down'); break;
                            case 'left': testMove = await client.emitMove('left'); break;
                            case 'right': testMove = await client.emitMove('right'); break;
                        }
                        
                        if (testMove) {
                            this.log(`Found alternative move: ${dir}`);
                            me.x = testMove.x;
                            me.y = testMove.y;
                            foundAlternative = true;
                            break;
                        }
                    }
                    
                    if (!foundAlternative) {
                        throw 'stucked';
                    }
                }
            }
            return true;
        }
    }
}

class PddlDelivery extends Plan {

    static isApplicableTo(pddl_deliver) {
        return pddl_deliver == 'pddl_deliver';
    }

    async execute(pddl_deliver, x, y) {
        if (this.stopped) throw ['stopped'];
        [prevX, prevY] = utils.updateBeliefPosition(prevX, prevY);

        let pddlProblem = new PddlProblem(
            'Deliveroo',
            pddlBeliefSet.objects.join(' '),
            pddlBeliefSet.toPddlString(),
            'and (at Tile_' + x + '_' + y + ') (not (canDeliver))'
        );
        
        this.log(`PDDL Problem - Current position: (${me.x}, ${me.y}), Target: (${x}, ${y})`);
        this.log(`PDDL Problem - Carrying parcels: ${carriedParcels.size > 0 ? 'Yes' : 'No'}`);
        utils.pddlRemoveDoublePredicates();

        let plan = await onlineSolver(pddlDomain.toPddlString(), pddlProblem.toPddlString());
        
        // Check if plan is valid and not empty
        if (!plan || plan.length === 0) {
            this.log('PDDL planning failed - no plan found. Current position:', me.x, me.y, 'Target:', x, y);
            // Fallback: try to deliver directly if we're at the delivery location
            if (me.x == x && me.y == y) {
                // Check if we're actually carrying parcels
                if (carriedParcels.size === 0) {
                    this.log('No parcels to deliver');
                    return true;
                }
                
                // Check if we're at a valid delivery point
                const deliveryPointId = `(${Math.floor(x)},${Math.floor(y)})`;
                const isDeliveryPoint = deliveryCells.has(deliveryPointId);
                if (!isDeliveryPoint) {
                    this.log(`Position (${x}, ${y}) is not a valid delivery point`);
                    throw ['Not at valid delivery point'];
                }
                                
                // Try to deliver and check if it was successful
                const result = await client.emitPutdown();
                
                // Set delivery flag to prevent immediate movement
                justDelivered = true;
                lastDeliveryTime = Date.now();
                
                // Add a small delay after delivery
                await new Promise(resolve => setTimeout(resolve, 100));
                                
                return true;
            } else
                throw ['PDDL planning failed - no valid plan found'];
        }
        
        // Execute the plan
        try {
            this.log(`Executing PDDL plan with ${plan.length} steps: ${plan.join(' -> ')}`);
            
            // Execute the plan step by step and stop after delivery
            let putdownExecuted = false;
            
            for (let i = 0; i < plan.length; i++) {
                if (this.stopped) throw ['stopped'];
                
                const step = plan[i];
                this.log(`Executing step ${i + 1}/${plan.length}: ${step}`);
                
                // Check if this is a putdown action and we're not at the delivery location yet
                if (step && String(step).toLowerCase().includes('putdown')) {
                    // Only execute putdown if we're at the delivery location
                    if (me.x == x && me.y == y) {

                        await pddlExecutor.exec([step]);
                        
                        // Set delivery flag to prevent immediate movement
                        justDelivered = true;
                        lastDeliveryTime = Date.now();
                        putdownExecuted = true;
                        // Add a longer delay after delivery to prevent immediate movement
                        await new Promise(resolve => setTimeout(resolve, 10));
                        break;
                    } else {
                        continue;
                    }
                }
                                
                // Execute movement actions normally
                await pddlExecutor.exec([step]);
                
                // Add a small delay between steps
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            
            // If we finished the plan but didn't execute PUTDOWN and we're at the delivery location, do it manually
            // DON'T REMOVE THIS
            if (!putdownExecuted && me.x == x && me.y == y && carriedParcels.size > 0) {
                this.log('PDDL plan completed but PUTDOWN not executed. Executing PUTDOWN manually.');
                await client.emitPutdown();
                justDelivered = true;
                lastDeliveryTime = Date.now();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            return true;
        } catch (error) {
            this.log('PDDL execution failed:', error);
            throw ['PDDL execution failed'];
        }
    }

}

class SimpleDelivery extends Plan {

    static isApplicableTo(simple_deliver, x, y) {
        return simple_deliver == 'simple_deliver';
    }

    async execute(simple_deliver, x, y) {
        if (this.stopped) throw ['stopped'];
        
        // Check if we're actually carrying parcels
        if (carriedParcels.size === 0) {
            this.log('No parcels to deliver');
            return true;
        }
        
        // Check if we're at a valid delivery point
        const deliveryPointId = `(${Math.floor(x)},${Math.floor(y)})`;
        const isDeliveryPoint = deliveryCells.has(deliveryPointId);
        if (!isDeliveryPoint) {
            this.log(`Position (${x}, ${y}) is not a valid delivery point`);
            throw ['Not at valid delivery point'];
        }
        
        // Simple delivery without PDDL - just put down if at delivery location
        if (me.x == x && me.y == y) {
            
            // Try to deliver and check if it was successful
            const result = await client.emitPutdown();
            
            // Add a small delay after delivery
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Check if we still have parcels (delivery might have failed)
            if (carriedParcels.size > 0) {
                this.log('Delivery might have failed, still carrying parcels');
                // Don't throw error, just return true to avoid infinite retry
                return true;
            }
            
            return true;
        } else {
            throw ['Not at delivery location'];
        }
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
        let noCandidates = true;
        let bestCandidate = null;
        let bestCandidatePath = null;
        if (candidates.length > 0) {
            // Sort candidates by lastSeen (oldest first)
            const sortedCandidates = [...candidates].sort((a, b) => a.lastSeen - b.lastSeen);
            
            // Find the first candidate with a valid path
            for (const candidate of sortedCandidates) {
                const shortestPath = utils.getShortestPath(me.x, me.y, candidate.x, candidate.y).path;
                if (shortestPath) {
                    noCandidates = false;
                    candidate.lastSeen = Date.now();
                    bestCandidate = candidate;
                    bestCandidatePath = shortestPath;
                    break;
                }
            }
            if (!noCandidates) {
                await this.subIntention( ['go_to', bestCandidate.x, bestCandidate.y, bestCandidatePath] );
                return true;
            }
        }
        if(noCandidates){


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
planLibrary.push( PddlDelivery )
planLibrary.push( SimpleDelivery )