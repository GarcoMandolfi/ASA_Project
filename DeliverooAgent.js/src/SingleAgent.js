import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import * as utils from "./utils.js"

// ============================================================================
// AGENT CONFIGURATION AND INITIALIZATION
// ============================================================================

// Get agent number from command line arguments
const agentNumber = process.argv[2] || '1'; // Default to agent 1 if no argument provided

// JWT tokens for authentication - each agent has a unique token
const AGENT1_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjIwNTE2NiIsIm5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSAxIiwidGVhbUlkIjoiNWUxNmRlIiwidGVhbU5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzUyMTQ5Mzg1fQ.eyiEl2lqQ0ez1ZWdkRIz4QCJh-hZA6EFi3B-0Yp9Cg0'
const AGENT2_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjU1ZTA0ZSIsIm5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSAyIiwidGVhbUlkIjoiMmJmYmZiIiwidGVhbU5hbWUiOiJBbmRpYW1vIGHCoXNjaWFyZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzUyMTQ5MzkyfQ.TJ8TUSPjzaEP1Sq79ejqSxA33ZaH-fcf32goUuLLQHA'

// Select token based on agent number
const selectedToken = agentNumber === '1' ? AGENT1_TOKEN : AGENT2_TOKEN;
console.log(`Starting agent ${agentNumber} with token: ${selectedToken.substring(0, 50)}...`);

// Initialize the Deliveroo API client
const client = new DeliverooApi(
    'http://localhost:8080',
    selectedToken
)

// Global configuration object - populated when config is received
let config = {};

// Handle configuration updates from the server
client.onConfig(cfg => {
    config = {
        ...cfg,
        PARCEL_DECADING_INTERVAL: utils.parseDecayInterval(cfg.PARCEL_DECADING_INTERVAL)
    }
    console.log('Agent configuration received:', config);
});

// ============================================================================
// BELIEF SET MANAGEMENT
// ============================================================================

/**
 * Current agent state - updated via onYou events
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: null, name: null, x: null, y: null, score: null};

/**
 * Map of free parcels available for pickup
 * Key: parcel ID, Value: parcel object with position, reward, and metadata
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, lastUpdate:number} > }
 */
const freeParcels = new Map();

/**
 * Map of parcels currently carried by this agent
 * Key: parcel ID, Value: parcel object with reward and metadata
 * @type { Map< string, {id: string, reward:number, lastUpdate:number} > }
 */
const carriedParcels = new Map();

/**
 * Map of other agents in the environment
 * Key: agent ID, Value: agent object with position, movement state, and metadata
 * @type { Map< string, {id: string, x:number, y:number, lastUpdate:number, isMoving:boolean, direction:string, occupiedCells:Array<String>, status:string } > }
 */
const otherAgents = new Map();

/**
 * Map of delivery points where parcels can be delivered
 * Key: cell ID, Value: delivery cell object with position and type
 * @type { Map< string, {x:number, y:number, type:Number} > }
 */
const deliveryCells = new Map();

/**
 * Map of generating cells where new parcels spawn
 * Key: cell ID, Value: generating cell object with position and type
 * @type { Map< string, {x:number, y:number, type:Number} > }
 */
const generatingCells = new Map();

/**
 * Array of strategic candidate positions for optimal parcel collection
 * Each candidate has position, nearby generating cells count, and last visit time
 * @type { Array<{id: string, x: number, y: number, generatingCellsNearby: number, lastSeen: number}> }
 */
const candidates = [];

// Export global state for use by other modules
export {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells, candidates}

// ============================================================================
// CALLBACKS
// ============================================================================

/**
 * Handle map initialization and setup
 * Creates the navigation graph and generates strategic candidate positions
 */
client.onMap((width, height, tiles) => {
    deliveryCells.clear();

    // Create 2D tile array and navigation graph
    const tiles2D = utils.createTiles2D(width, height, tiles);
    const { graph, nodePositions } = utils.createGraphFromTiles(width, height, tiles2D);

    // Store graph data globally for pathfinding
    global.graph = graph;
    global.nodePositions = nodePositions;
    global.mapWidth = width;
    global.mapHeight = height;
    global.tiles2D = tiles2D;
    
    // Generate strategic candidate positions after graph is built
    makeCandidates();
})

/**
 * Generate strategic candidate positions for optimal parcel collection
 * Analyzes generating cells to find the best positions with maximum coverage
 * Optimizes performance by avoiding redundant calculations for connected cells
 */
function makeCandidates() {
    if (!global.graph || !global.nodePositions) {
        console.log('Graph not ready for candidate generation');
        return;
    }

    const parcelObsDistance = config.PARCELS_OBSERVATION_DISTANCE || 5;
    const allCells = [];
    const processedCells = new Set(); // Track processed generating cells to avoid redundancy
    
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
                
                // Check if this cell is directly connected (no grey cells in between)
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
        
        // Add generating cell to candidate list
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
    
    // Sort by number of generating cells nearby (descending) for optimal coverage
    allCells.sort((a, b) => b.generatingCellsNearby - a.generatingCellsNearby);
    
    // Select top 3 candidates that are farthest from each other for maximum coverage
    const selectedCandidates = [];
    
    if (allCells.length > 0) {
        // Select first candidate (highest score - most generating cells nearby)
        selectedCandidates.push(allCells[0]);
        
        if (allCells.length > 1) {
            // Select second candidate: farthest from the first for better distribution
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
    
    // Update the global candidates list and ensure we have 3 candidates
    candidates.length = 0; // Clear existing candidates
    candidates.push(...selectedCandidates);
    if (candidates.length > 0) {
        while (candidates.length < 3) {
            candidates.push(candidates[0]); // Duplicate first candidate if needed
        }   
    }
    
    console.log('Generated candidates:', candidates.map(c => 
        `${c.id} (${c.x},${c.y}) with ${c.generatingCellsNearby} generating cells nearby`
    ));
}

/**
 * Handle agent state updates
 * Updates current agent position and triggers delivery point finding when stationary
 */
client.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score


} )

/**
 * Periodic parcel decay timer
 * Reduces parcel rewards over time based on the configured decay interval
 */
setInterval(() => {
    if (!isFinite(config.PARCEL_DECADING_INTERVAL)) return;

    utils.decayParcels();
    
}, 1000);


/**
 * Handle agent sensing events
 * Updates information about other agents in the environment and manages pathfinding obstacles
 */
client.onAgentsSensing(agents => {
    const seenAgentIds = new Set();
    
    for (let a of agents) {
        seenAgentIds.add(a.id);
        
        // Skip our own agent
        if (a.id === me.id) continue;
        
        // Calculate agent movement state and occupied cells
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
        
        // Block new positions to prevent pathfinding conflicts
        utils.blockAgentPositions(a.id, occupiedCells);
    }
    
    // Check all tracked agents for visibility and update their status
    for (let [agentId, agent] of otherAgents) {
        const distance = Math.abs(agent.x - me.x) + Math.abs(agent.y - me.y);
        const canSeeAgent = distance < config.AGENTS_OBSERVATION_DISTANCE;
        const agentIsVisible = seenAgentIds.has(agentId);
        
        if (canSeeAgent) {
            if (agentIsVisible) {
                // Agent is visible - update last seen timestamp
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


/**
 * Handle parcel sensing events
 * Updates the state of free and carried parcels based on current observations
 */
client.onParcelsSensing( async (pp) => {
    carriedParcels.clear();

    // Remove parcels that are no longer visible or have been picked up
    for (const [id, parcel] of freeParcels) {
        if (utils.manhattanDistance({ x: parcel.x, y: parcel.y }, me) < config.PARCELS_OBSERVATION_DISTANCE && !pp.find(p => p.id === parcel.id))
            freeParcels.delete(id);
    }

    // Process all sensed parcels
    for (const p of pp) {
        if (p.carriedBy === me.id && !carriedParcels.has(p.id)) {
            // Parcel is being carried by this agent
            freeParcels.delete(p.id);
            carriedParcels.set(p.id, {id:p.id, reward:p.reward, lastUpdate:Date.now()});
        }
        else if (p.carriedBy === null) {
            // Parcel is free and available for pickup
            utils.parcelUpdate(p);
        }
        else {
            // Parcel is carried by another agent - remove from free parcels
            freeParcels.delete(p.id);
        }
    }
});

// ============================================================================
// OPTION GENERATION and FILTERING
// ============================================================================

/**
 * Generate the best action option based on current state
 * Prioritizes delivery if carrying parcels, otherwise looks for pickup opportunities
 */
function generateOptions () {
    const carriedTotal = utils.carriedValue();

    let best_option = null;
    let best_distance = Number.MAX_VALUE;

    // Check delivery option if carrying valuable parcels
    if (carriedTotal != 0) {
        const bestDelivery = utils.findClosestDelivery(me.x, me.y);
        if (bestDelivery && bestDelivery.deliveryPoint) {
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
            if (pickupPath && pickupPath.path && pickupPath.cost < best_distance) {
                best_distance = pickupPath.cost;
                best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, pickupPath.path];
            }
        }
    }
    
    // Push the best option found or idle if no good options
    if (best_option !== null && best_distance !== null) {
        myAgent.push(best_option);
    }
    else {
        myAgent.push(['idle']);
    }
}


// Register option generation as event handlers
client.onParcelsSensing( generateOptions )
client.onAgentsSensing( generateOptions )
client.onYou( generateOptions )


// ============================================================================
// INTENTION REVISION SYSTEM
// ============================================================================


/**
 * Main intention revision system that manages the agent's action queue
 * Processes intentions in priority order and handles intention validation
 */
class IntentionRevision {

    #intention_queue = new Array();
    get intention_queue () {
        return this.#intention_queue;
    }

    /**
     * Main control loop that processes intentions and generates new options
     */
    async loop ( ) {
        await new Promise(res => setTimeout(res, 50));
        while ( true ) {
            // Consumes intention_queue if not empty
            if ( this.intention_queue.length > 0 ) {
            
                // Current intention
                const intention = this.intention_queue[0];
                
                // Validate if the queued intention is still valid
                let id = intention.predicate[3]
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
                // Generate new options when queue is empty
                generateOptions();
            }
            // Postpone next iteration at setImmediate
            await new Promise( res => setImmediate( res ) );
        }
    }


    /**
     * Log messages for debugging
     */
    log ( ...args ) {
        console.log( ...args )
    }

    /**
     * Add a new intention to the queue with duplicate checking and priority sorting
     * @param {Array} predicate - The action predicate to be executed
     */
    async push(predicate) {

        if(!Number.isInteger(me.x) || !Number.isInteger(me.y)) return;

        // Check if already queued (same action type and target)
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

        // Update existing intention if found, otherwise create new one
        let existingIntention = this.intention_queue.find(i => {
            return i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ');
        });
        if (existingIntention && existingIntention.predicate[0] != "idle")
            existingIntention.updateIntention(predicate);
        
        const intention = new Intention( this, predicate );
        this.intention_queue.push( intention );

        // Sort by score descending to prioritize high-value actions
        this.intention_queue.sort((a, b) => {
            let result  =  utils.getScore(b.predicate) - utils.getScore(a.predicate);
            return result;
        });

        // Stop current intention if it's no longer at the top
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


// ============================================================================
// PLAN LIBRARY AND EXECUTION
// ============================================================================

/**
 * Library of available plans for executing different types of actions
 */
const planLibrary = [];

/**
 * Base class for all plans that can be executed by the agent
 * Provides common functionality for plan management and sub-intention handling
 */
class Plan {

    // This is used to stop the plan
    #stopped = false;
    stop () {
        this.#stopped = true;
        for ( const i of this.#sub_intentions ) {
            i.stop();
        }
    }
    get stopped () {
        return this.#stopped;
    }

    /**
     * Reference to the parent intention revision system
     */
    #parent;

    constructor ( parent ) {
        this.#parent = parent;
    }

    /**
     * Log messages with proper indentation for debugging
     */
    log ( ...args ) {
        if ( this.#parent && this.#parent.log )
            this.#parent.log( '\t', ...args )
        else
            console.log( ...args )
    }

    /**
     * Array of sub-intentions that can be executed in parallel
     */
    #sub_intentions = [];

    /**
     * Create and execute a sub-intention as part of this plan
     * @param {Array} predicate - The action predicate for the sub-intention
     */
    async subIntention ( predicate ) {
        const sub_intention = new Intention( this, predicate );
        this.#sub_intentions.push( sub_intention );
        return sub_intention.achieve();
    }

}

/**
 * Plan for picking up parcels
 * Moves to the parcel location and attempts to pick it up
 */
class GoPickUp extends Plan {

    /**
     * Check if this plan can handle the given action
     */
    static isApplicableTo ( go_pick_up, x, y, id, path ) {
        return go_pick_up == 'go_pick_up';
    }

    /**
     * Execute the pickup action: move to location and pick up parcel
     */
    async execute ( go_pick_up, x, y, id, path ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y, path] );
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await client.emitPickup()
        return true;
    }

}

/**
 * Plan for delivering parcels to delivery points
 * Moves to the delivery location and attempts to put down parcels
 */
class GoDeliver extends Plan {

    /**
     * Check if this plan can handle the given action
     */
    static isApplicableTo ( go_deliver, x, y, path ) {
        return go_deliver == 'go_deliver';
    }

    /**
     * Execute the delivery action: move to location and put down parcels
     */
    async execute ( go_deliver, x, y, path ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y, path] );
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await client.emitPutdown()
        return true;
    }

}

/**
 * Plan for moving to a specific location using pathfinding
 * Follows a pre-calculated path to reach the target destination
 */
class BlindMove extends Plan {

    /**
     * Check if this plan can handle the given action
     */
    static isApplicableTo ( go_to, x, y, path ) {
        return go_to == 'go_to';
    }

    /**
     * Execute the movement action: follow the path step by step
     */
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

/**
 * Plan for idle movement and strategic positioning
 * Either moves to strategic candidate positions or performs random exploration
 */
class IdleMove extends Plan {

    // Available movement directions for random exploration
    static directions = ['up', 'right', 'down', 'left'];
    static LastDir = Math.floor(Math.random() * IdleMove.directions.length);
    static _prevCell = null;

    /**
     * Check if this plan can handle the given action
     */
    static isApplicableTo(idle) {
        return idle == 'idle';
    }

    /**
     * Execute idle movement: prioritize strategic positions, fallback to random movement
     */
    async execute(go_to) {
        if (this.stopped) throw ['stopped'];
        
        let noCandidates = true;
        let bestCandidate = null;
        let bestCandidatePath = null;
        
        // Try to move to strategic candidate positions first
        if (candidates.length > 0) {
            // Sort candidates by lastSeen (oldest first) for better coverage
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
        
        // Fallback to random movement if no valid candidates
        if(noCandidates){
            // Perform random exploration when no strategic candidates are available
            const x = me.x;
            const y = me.y;
            const currentNodeId = '(' + x + ',' + y + ')';
            const prevCell = IdleMove._prevCell;
            let foundMove = false;
            let skippedPrev = null;

            // Shuffle directions for equal chance of movement
            const dirs = IdleMove.directions.slice();
            for (let i = dirs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
            }

            // Try all directions, avoiding backtracking when possible
            for (const dir of dirs) {
                let [targetX, targetY] = [x, y];
                if (dir === 'up') targetY++;
                else if (dir === 'down') targetY--;
                else if (dir === 'left') targetX--;
                else if (dir === 'right') targetX++;
                const targetNodeId = '(' + targetX + ',' + targetY + ')';
                
                // Check if the target cell is valid and reachable
                if (
                    global.graph &&
                    global.graph.has(currentNodeId) &&
                    global.graph.has(targetNodeId) &&
                    global.graph.get(currentNodeId).has(targetNodeId)
                ) {
                    // Skip previous cell to avoid immediate backtracking
                    if (prevCell && targetNodeId === prevCell) {
                        skippedPrev = { dir, targetX, targetY, targetNodeId };
                        continue;
                    }
                    
                    // Attempt to move in the chosen direction
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

            // If no move found and we skipped the previous cell, try it now as fallback
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
                // No valid move found, remain idle and reset state
                IdleMove.LastDir = (IdleMove.LastDir + 1) % 4;
                IdleMove._prevCell = null;
            }
        }

        return true;
    }
}

// Register all plan classes in the plan library
planLibrary.push( GoPickUp )
planLibrary.push( GoDeliver )
planLibrary.push( BlindMove )
planLibrary.push( IdleMove )