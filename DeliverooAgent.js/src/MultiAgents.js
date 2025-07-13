// ============================================================================
// MULTI-AGENT SYSTEM
// Handles agent initialization, state, communication, and intention revision
// ============================================================================

import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import * as utils from "./mUtils.js"

// Get agent number from command line arguments (default to agent 1)
const agentNumber = process.argv[2] || '1';

// JWT tokens for both agents
const AGENT1_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjIwNTE2NiIsIm5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSAxIiwidGVhbUlkIjoiNWUxNmRlIiwidGVhbU5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzUyMTQ5Mzg1fQ.eyiEl2lqQ0ez1ZWdkRIz4QCJh-hZA6EFi3B-0Yp9Cg0'
const AGENT2_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjU1ZTA0ZSIsIm5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSAyIiwidGVhbUlkIjoiMmJmYmZiIiwidGVhbU5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzUyMTQ5MzkyfQ.TJ8TUSPjzaEP1Sq79ejqSxA33ZaH-fcf32goUuLLQHA'

// Select token based on agent number
const selectedToken = agentNumber === '1' ? AGENT1_TOKEN : AGENT2_TOKEN;

// Helper to extract agent id from JWT token
function extractAgentId(token) {
    const payload = token.split('.')[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded).id;
}

// Extract agent IDs from tokens
const AGENT1_ID = extractAgentId(AGENT1_TOKEN);
const AGENT2_ID = extractAgentId(AGENT2_TOKEN);

// Set my agent ID and the other agent's ID based on which token is selected
const MY_AGENT_ID = selectedToken === AGENT1_TOKEN ? AGENT1_ID : AGENT2_ID;
const OTHER_AGENT_ID = selectedToken === AGENT1_TOKEN ? AGENT2_ID : AGENT1_ID;

global.MY_AGENT_ID = MY_AGENT_ID;
global.OTHER_AGENT_ID = OTHER_AGENT_ID;

// Initialize Deliveroo API client
const client = new DeliverooApi(
    'http://localhost:8080',
    selectedToken
)

// Global configuration object (populated onConfig)
let config = {};

// Handle configuration updates from the server
client.onConfig(cfg => {
    config = {
        ...cfg,
        PARCEL_DECADING_INTERVAL: utils.parseDecayInterval(cfg.PARCEL_DECADING_INTERVAL)
    }

});

/**
 * Agent state object (updated via onYou events)
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: null, name: null, x: null, y: null, score: null};

/**
 * Map of free parcels available for pickup
 * Key: parcel ID, Value: parcel object with position, reward, and metadata
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, lastUpdate:number, lastSeen:number} > }
 */
const freeParcels = new Map();

/**
 * Set of parcel IDs assigned to the other agent (for coordination)
 * @type { Set<string> }
 */
const otherAgentParcels = new Set();

// #######################################################################################################################
// CHECK CARRIED BY
//##########################################################################################################################
// (Legacy section marker: can be removed or clarified if not used)

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

// Communication and update timing constants
const COMM_DELAY = config.MOVEMENT_DURATION; // ms
const UPDATE_THRESHOLD = 100; // ms - minimum time difference for updates
global.COMM_DELAY = COMM_DELAY;

// Export global state for use in other modules
export {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells, OTHER_AGENT_ID, otherAgentParcels, candidates}

// Declare myAgent globally to avoid scope issues
let myAgent;

// ============================================================================
// AGENT STATE SYNCHRONIZATION AND COMMUNICATION
// ============================================================================

// Periodically send our state and perceived world state to the other agent.
// This includes our own position, the state of all known agents, free parcels, and carried parcels.
// This enables both agents to maintain a synchronized view of the environment for coordination.
setInterval(() => {
    // Prepare the data to send as plain objects
    // Clone otherAgents and add/update our own agent info
    const otherAgentsToSend = new Map(otherAgents);
    
    const isMoving = !Number.isInteger(me.x) || !Number.isInteger(me.y);
    const direction = utils.getAgentDirection(me);
    const occupiedCells = utils.getAgentOccupiedCells(me);
    
    // Always include our own latest state in the message
    otherAgentsToSend.set(MY_AGENT_ID, {
        id: me.id,
        x: me.x,
        y: me.y,
        lastUpdate: Date.now(),
        isMoving: isMoving,
        direction: direction,
        occupiedCells: occupiedCells,
        status: 'self'
    });
    // Prepare the data object for transmission
    const data = {
        sendingFreeParcels: Object.fromEntries(freeParcels),
        sendingOtherAgents: Object.fromEntries(otherAgentsToSend),
        sendingCarriedParcels: Object.fromEntries(carriedParcels)
    };
    // Send the data to the other agent using the Deliveroo API
    client.emitSay(OTHER_AGENT_ID, data);
}, 100);

// ============================================================================
// MESSAGE HANDLING AND STATE MERGE
// ============================================================================

// Handle incoming messages from the other agent
client.onMsg(async (fromId, fromName, msg, reply) => {
    // Only process messages from the other agent (ignore others)
    if (fromId !== OTHER_AGENT_ID) return;

    // Defensive: handle both string and object messages
    let data;
    if (typeof msg === 'string' && (msg.trim().startsWith('{') || msg.trim().startsWith('['))) {
        try {
            data = JSON.parse(msg);
        } catch (e) {
            console.error('Failed to parse message:', msg);
            return;
        }
    } else {
        data = msg;
    }

    // Handle parcel deletion requests and state synchronization
    if (data && data.type === 'deleteParcel' && data.parcelId) {
        // Remove the specified parcel from our freeParcels map
        freeParcels.delete(data.parcelId);
    } else if (data && (data.sendingFreeParcels || data.sendingOtherAgents || data.sendingCarriedParcels)) {
        // Convert received objects back to Maps for easier manipulation
        const receivedFreeParcels = new Map(Object.entries(data.sendingFreeParcels || {}));
        const receivedOtherAgents = new Map(Object.entries(data.sendingOtherAgents || {}));
        const receivedCarriedParcels = new Map(Object.entries(data.sendingCarriedParcels || {}));
        
        // Update our freeParcels map with any newer information from the other agent
        for (const [id, receivedParcel] of receivedFreeParcels) {
            const localParcel = freeParcels.get(id);
            // Only update if the received info is newer and not assigned to the other agent
            if (!localParcel || (receivedParcel.lastSeen > (localParcel.lastSeen || 0) + UPDATE_THRESHOLD) && !otherAgentParcels.has(id)) {
                freeParcels.set(id, { ...localParcel, ...receivedParcel });
            }
        }
        
        // If the other agent is now carrying a parcel, remove it from our otherAgentParcels set
        for (const [id, receivedCarriedParcel] of receivedCarriedParcels) {
            if (otherAgentParcels.has(id)) {
                console.log(`Removing parcel ${id} from otherAgentParcels - now being carried by other agent`);
                otherAgentParcels.delete(id);
            }
        }
        
        // Update our knowledge of other agents (except ourselves)
        for (const [id, receivedAgent] of receivedOtherAgents) {
            if (id === MY_AGENT_ID) continue; // Skip self
            const localAgent = otherAgents.get(id);
            // Only update if received info is more recent by at least the threshold
            if (!localAgent || (receivedAgent.lastUpdate > (localAgent.lastUpdate || 0) + UPDATE_THRESHOLD)) {
                // Unblock old occupiedCells if present
                if (localAgent && localAgent.occupiedCells) {
                    utils.unblockAgentPositions(id, localAgent.occupiedCells);
                }
                otherAgents.set(id, { ...localAgent, ...receivedAgent });
                // Block new occupiedCells if present
                if (receivedAgent.occupiedCells) {
                    utils.blockAgentPositions(id, receivedAgent.occupiedCells);
                }
            }
        }
    } 

    // Handle intention drop negotiation (if enabled)
    if (typeof msg === 'string' && msg.startsWith('drop_intention?')) {
        console.log('drop_intention?', msg);
        const payload = msg.replace('drop_intention?', '');
        const [parcelId, theirScoreStr] = payload.split('|');
        const theirScore = parseFloat(theirScoreStr);
        const bestIntention = myAgent.intention_queue[0]?.predicate;
        if (!bestIntention) {
            console.log('bestIntention is undefined');
            reply({ answer: 'no' });
            return;
        }
        // If our best intention is to pick up the same parcel, compare scores
        if (
            bestIntention &&
            bestIntention[0] === 'go_pick_up' &&
            bestIntention[3] === parcelId
        ) {
            const myScore = utils.getScore(bestIntention);
            console.log('myScore', myScore);
            console.log('theirScore', theirScore);
            // If our score is higher, keep the intention; otherwise, drop it
            if (reply) {
                if (myScore >= theirScore) {
                    reply({ answer: 'yes' }); // keep intention
                    console.log('keeping intention');
                    console.log('otherAgentParcels', otherAgentParcels);
                    console.log('freeParcels keeping', freeParcels);
                } else {
                    reply({ answer: 'no' }); // drop intention
                    otherAgentParcels.add(parcelId);
                    console.log('nooooot keeping');
                    console.log('otherAgentParcels', otherAgentParcels);
                    console.log('freeParcels deleting', freeParcels);
                }
            }
        } else {
            // If our best intention is not to pick up this parcel, always reply 'no'
            console.log('bestIntention is not a go_pick_up');
            console.log(bestIntention);
            console.log('otherAgentParcels', otherAgentParcels);
            console.log('freeParcels', freeParcels);
            reply({ answer: 'no' });
        }
        return;
    }
});


// ============================================================================
// MAP INITIALIZATION AND CANDIDATE GENERATION
// ============================================================================

// Handle map initialization and setup
// This event is triggered when the map is received from the server
client.onMap((width, height, tiles) => {
    // Clear existing delivery cells to avoid stale data
    deliveryCells.clear();

    // Create 2D tile array and navigation graph
    const tiles2D = utils.createTiles2D(width, height, tiles);
    const { graph, nodePositions } = utils.createGraphFromTiles(width, height, tiles2D);

    // Store global references for navigation and pathfinding
    global.graph = graph;
    global.nodePositions = nodePositions;
    global.mapWidth = width;
    global.mapHeight = height;
    global.tiles2D = tiles2D;
    // Generate strategic candidate positions for optimal parcel collection
    makeCandidates();
})

/**
 * Generate strategic candidate positions for optimal parcel collection
 * Analyzes generating cells and selects positions that maximize coverage
 */
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
    // Ensure we always have 3 candidates (duplicate if necessary)
    if (candidates.length > 0) {
        while (candidates.length < 3) {
            candidates.push(candidates[0]);
        }   
    }
    
    console.log('Generated candidates:', candidates.map(c => 
        `${c.id} (${c.x},${c.y}) with ${c.generatingCellsNearby} generating cells nearby`
    ));
}

// ============================================================================
// AGENT POSITION AND STATE UPDATES
// ============================================================================

/**
 * Handle agent position and state updates
 * Updates the agent's current position and triggers delivery calculations
 */
client.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score
    // Uncomment for debugging:
    // console.log('me', me);

    // Update delivery calculations when position is stable
    if (global.graph && Number.isInteger(me.x) && Number.isInteger(me.y)) {
        utils.findClosestDelivery(me.x, me.y);
    }
} )

// ============================================================================
// PERIODIC TASKS AND MAINTENANCE
// ============================================================================

/**
 * Periodic parcel decay timer
 * Reduces parcel rewards over time based on the decay interval
 */
setInterval(() => {
    if (!isFinite(config.PARCEL_DECADING_INTERVAL)) return;

    utils.decayParcels();
    
}, 1000);

/**
 * Clear otherAgentParcels every 5 seconds
 * This prevents stale assignments from blocking parcel pickup indefinitely
 */
setInterval(() => {
    if (otherAgentParcels.size > 0) {
        console.log('Clearing otherAgentParcels:', otherAgentParcels.size, 'parcels');
        otherAgentParcels.clear();
    }
}, 5000);

// ============================================================================
// AGENT SENSING AND POSITION TRACKING
// ============================================================================

/**
 * Handle agent sensing and position tracking
 * Updates the state of other agents and manages collision avoidance
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
        
        // Block new positions to prevent pathfinding through occupied cells
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

// ============================================================================
// PARCEL SENSING AND STATE MANAGEMENT
// ============================================================================

/**
 * Handle parcel sensing and state management
 * Updates the state of free and carried parcels
 */
client.onParcelsSensing(async (pp) => {
    carriedParcels.clear();

    // Remove parcels that are no longer visible or have been picked up
    for (const [id, parcel] of freeParcels) {
        // Remove parcels that are assigned to the other agent
        if (otherAgentParcels.has(id)) {
            freeParcels.delete(id);
        }
        else if (
            utils.manhattanDistance({ x: parcel.x, y: parcel.y }, me) < config.PARCELS_OBSERVATION_DISTANCE &&
            !pp.find(p => p.id === parcel.id)
        ) {
            freeParcels.delete(id);
            console.log("someone took this parcel", id);
            // Notify the other agent to delete this parcel
            client.emitSay(OTHER_AGENT_ID, { type: 'deleteParcel', parcelId: id });
        }
    }

    // Process all sensed parcels
    for (const p of pp) {
        if (p.carriedBy === me.id && !carriedParcels.has(p.id)) {
            // Parcel is being carried by this agent
            freeParcels.delete(p.id);
            // Notify the other agent to delete this parcel
            client.emitSay(OTHER_AGENT_ID, { type: 'deleteParcel', parcelId: p.id });
            carriedParcels.set(p.id, { id: p.id, reward: p.reward, lastUpdate: Date.now() });
        } else if (p.carriedBy === null) {
            // Parcel is free and available for pickup
            // Note: We add ALL free parcels to freeParcels, regardless of assignment
            // The assignment check happens in generateOptions when deciding what to pick up

            let existing = freeParcels.get(p.id);
            const now = Date.now();
            // Only update if this is a new parcel or if enough time has passed since last update
            if (!existing || (now - existing.lastUpdate > UPDATE_THRESHOLD)) {
                freeParcels.set(p.id, {
                    ...(existing || {}),
                    ...p,
                    lastUpdate: now,
                    lastSeen: now,
                });
            }
        } else {
            // Parcel is being carried by another agent
            // Notify the other agent to delete this parcel
            client.emitSay(OTHER_AGENT_ID, { type: 'deleteParcel', parcelId: p.id });
            freeParcels.delete(p.id);
        }
    }
});

// ============================================================================
// OPTIONS GENERATION AND FILTERING
// ============================================================================

/**
 * Master intention reviser system (placeholder for future coordination)
 * Currently only runs if both agents are in the map and only for Agent 1
 */
function masterIntentionReviser() {
    // Only run if both agents are in the map
    if (!otherAgents.has(OTHER_AGENT_ID) || !otherAgents.has(MY_AGENT_ID)) {
        return;
    }
    
    // Only Agent 1 (master) runs this
    if (MY_AGENT_ID !== AGENT1_ID) {
        return;
    }
    
    // Get Agent 2's top 2 intentions from the message
    // This will be implemented in the message handler
}

/**
 * Generate and evaluate possible actions for the agent
 * Prioritizes delivery when carrying parcels, then considers pickup options
 */
function generateOptions () {
    const carriedTotal = utils.carriedValue();

    let best_option = null;
    let best_distance = Number.MAX_VALUE;
    let second_best_option = null;
    let second_best_distance = Number.MAX_VALUE;

    // Check delivery option if carrying valuable parcels
    if (carriedTotal != 0) {
        const bestDelivery = utils.findClosestDelivery(me.x, me.y);
        
        if (bestDelivery && bestDelivery.path && bestDelivery.deliveryPoint) {
            best_option = ['go_deliver', bestDelivery.deliveryPoint.x, bestDelivery.deliveryPoint.y, bestDelivery.path];
            best_distance = bestDelivery.distance;
        } else {
            // No delivery possible, try to deliver to other agent
            const other = otherAgents.get(OTHER_AGENT_ID);
            if (other && other.x !== undefined && other.y !== undefined) {
                const adjacentPositions = [
                    {x: other.x - 1, y: other.y}, // left
                    {x: other.x + 1, y: other.y}, // right
                    {x: other.x, y: other.y - 1}, // down
                    {x: other.x, y: other.y + 1}  // up
                ];
                
                let deliveryNeighbour = {x: other.x, y: other.y}; // fallback to agent position
                for (const pos of adjacentPositions) {
                    const nodeId = "(" + pos.x + "," + pos.y + ")";
                    if (global.graph.has(nodeId)) {
                        if (utils.getShortestPath(me.x, me.y, pos.x, pos.y).path) {
                            deliveryNeighbour = pos;
                            break;
                        }
                    }
                }
                const pathToOther = utils.getShortestPath(me.x, me.y, deliveryNeighbour.x, deliveryNeighbour.y);
                if (pathToOther && pathToOther.path) {
                    best_option = ['go_deliver_agent', other.x, other.y, pathToOther.path];
                    best_distance = pathToOther.cost;
                }
            }
        }
    }

    // Always consider pickup options too, and pick nearest
    for (const parcel of freeParcels.values()) {
        // Uncomment for debugging:
        // console.log('parcel', parcel);
        if (
            parcel && // Check if parcel is not null
            Number.isInteger(me.x) && Number.isInteger(me.y) &&
            Number.isInteger(parcel.x) && Number.isInteger(parcel.y) &&
            !otherAgentParcels.has(parcel.id)
        ) {
            const pickupPath = utils.getShortestPath(me.x, me.y, parcel.x, parcel.y);
            if (pickupPath && pickupPath.path && pickupPath.cost < best_distance) {
                second_best_distance = best_distance;
                second_best_option = best_option;
                best_distance = pickupPath.cost;
                // Uncomment for debugging:
                // console.log('best_option', best_option);
                best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, pickupPath.path];
            } else if (pickupPath && pickupPath.path && pickupPath.cost < second_best_distance) {
                second_best_distance = pickupPath.cost;
                second_best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, pickupPath.path];
            }
        }
    }
    
    // Push the best option found to the agent's intention queue
    if (best_option !== null && best_distance !== null) {
        myAgent.push(best_option);
    } else {
        myAgent.push(['idle']);
    }
}

// ============================================================================
// EVENT HANDLERS FOR OPTIONS GENERATION
// ============================================================================

// Trigger options generation when parcels are sensed
client.onParcelsSensing( generateOptions )
// Trigger options generation when agents are sensed
client.onAgentsSensing( generateOptions )
// Trigger options generation when our position changes
client.onYou( generateOptions )

// ============================================================================
// INTENTION REVISION SYSTEM
// ============================================================================

/**
 * Main intention revision system that manages the agent's decision-making
 * Processes intentions from the queue and generates new options when needed
 * Implements a BDI (Belief-Desire-Intention) architecture for agent behavior
 */
class IntentionRevision {

    /**
     * Queue of intentions to be executed, sorted by priority score
     * @type { Array<Intention> }
     */
    #intention_queue = new Array();
    get intention_queue () {
        return this.#intention_queue;
    }

    /**
     * Main decision loop that processes intentions and manages agent behavior
     * Continuously evaluates and executes intentions while generating new options
     */
    async loop ( ) {
        // Initial delay to allow system setup
        await new Promise(res => setTimeout(res, 50));
        
        while ( true ) {
            // Process intentions if queue is not empty
            if ( this.intention_queue.length > 0 ) {
                // Get the highest priority intention (first in queue)
                const intention = this.intention_queue[0];
                
                // Handle idle intentions (no specific action needed)
                if (intention.predicate[0] == 'idle') {
                    await intention.achieve()
                    .catch( error => {
                        // Silently handle errors for idle intentions
                    } );
                    this.intention_queue.shift();
                    continue;
                }
                
                // Validate that the intention is still achievable
                // Check if the target parcel still exists and is valid
                let id = intention.predicate[3]
                let p = freeParcels.get(id)
                if ( !utils.stillValid(intention.predicate) ) {
                    this.intention_queue.shift();
                    continue;
                }
                
                // Inter-agent coordination for pickup intentions
                // Agent 2 asks Agent 1 for permission to pick up parcels
                if (intention.predicate[0] == 'go_pick_up') {
                    if (otherAgents.has(OTHER_AGENT_ID) && MY_AGENT_ID !== AGENT1_ID) {
                        // Send negotiation request with parcel ID and score
                        let reply = await client.emitAsk(OTHER_AGENT_ID, `drop_intention?${id}|${utils.getScore(intention.predicate)}`);
                        if (reply && reply['answer'] === 'yes') {
                            // Other agent has higher priority - drop this intention
                            console.log('dropping intention cause said yesssss', intention.predicate[0]);
                            this.intention_queue.shift();
                            otherAgentParcels.add(id);
                            console.log('otherAgentParcels', otherAgentParcels);
                            console.log('freeParcels id', freeParcels);
                            continue;
                        }
                        if (reply && reply['answer'] === 'no') {
                            // We have higher priority - keep the intention
                            console.log('NOT dropping intention cause said noooooo', intention.predicate[0]);
                            console.log('otherAgentParcels', otherAgentParcels);
                            console.log('freeParcels id', freeParcels);
                        }
                    }
                }
                
                // Execute the intention using available plans
                await intention.achieve()
                .catch( error => {
                    // Handle execution errors gracefully
                } );

                // Remove completed intention from queue
                this.intention_queue.shift();
            }
            else {
                // No intentions in queue - generate new options
                generateOptions();
            }
            
            // Yield control to allow other operations
            await new Promise( res => setImmediate( res ) );
        }
    }

    /**
     * Add a new intention to the queue with duplicate prevention
     * Handles intention updates and priority-based sorting
     * @param { Array } predicate - The intention predicate (e.g., ['go_pick_up', x, y, id, path])
     */
    async push(predicate) {
        // Only add intentions when agent position is stable
        if(!Number.isInteger(me.x) || !Number.isInteger(me.y)) return;

        // Check if intention is already being executed (first 3 elements match)
        const last = this.intention_queue[this.intention_queue.length - 1];
        if ( last && last.predicate.slice(0, 3).join(' ') == predicate.slice(0, 3).join(' ') ) {
            return; // intention is already being achieved
        }
        
        // Check for duplicate intentions with same first 4 elements
        if (this.intention_queue.some(i =>
            i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ')
        )) {
            return;
        }

        // Update existing intention if it exists (for path updates)
        let existingIntention = this.intention_queue.find(i => {
            return i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ');
        });
        if (existingIntention && existingIntention.predicate[0] != "idle")
            existingIntention.updateIntention(predicate);
            
        // Create new intention and add to queue
        const intention = new Intention( this, predicate );
        this.intention_queue.push( intention );

        // Sort queue by priority score (highest first)
        this.intention_queue.sort((a, b) => {
            let result  =  utils.getScore(b.predicate) - utils.getScore(a.predicate);
            return result;
        });

        // Stop current intention if it's no longer the highest priority
        if (last) {
            last.stop();
        }
    }
}


/**
 * Represents a single intention to be achieved by the agent
 * Contains the predicate (goal) and manages execution through available plans
 */
class Intention {

    /**
     * Currently executing plan for this intention
     * @type { Plan }
     */
    #current_plan;
    
    /**
     * Flag indicating if this intention has been stopped
     * @type { boolean }
     */
    #stopped = false;
    get stopped () {
        return this.#stopped;
    }
    
    /**
     * Stop this intention and its current plan
     */
    stop () {
        this.#stopped = true;
        if ( this.#current_plan)
            this.#current_plan.stop();
    }

    /**
     * Reference to the parent IntentionRevision system
     * @type { IntentionRevision }
     */
    #parent;

    /**
     * The intention predicate (goal) to be achieved
     * Format varies by intention type:
     * - ['go_pick_up', x, y, id, path]
     * - ['go_deliver', x, y, path]
     * - ['go_deliver_agent', x, y, path]
     * - ['go_to', x, y, path]
     * - ['idle']
     * @type { Array }
     */
    get predicate () {
        return this.#predicate;
    }
    #predicate;

    /**
     * Create a new intention with the given predicate
     * @param { IntentionRevision } parent - The parent intention revision system
     * @param { Array } predicate - The intention predicate
     */
    constructor ( parent, predicate ) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    /**
     * Log messages with proper indentation
     * @param { ...any } args - Arguments to log
     */
    log ( ...args ) {
        if ( this.#parent && this.#parent.log )
            this.#parent.log( '\t', ...args )
    }

    /**
     * Update the intention predicate with new information
     * Typically used to update paths when better routes are found
     * @param { Array } predicate - New predicate data
     * @returns { boolean } - True if update was successful
     */
    updateIntention(predicate) {
        switch(predicate[0]){
            case "go_pick_up":
                this.predicate[4] = predicate[4]; // Update path
                break;
            case "go_deliver":
                this.predicate[3] = predicate[3]; // Update path
                break;
            case "go_deliver_agent":
                this.predicate[3] = predicate[3]; // Update path
                break;
            default:
                return false;
        }
        return true;
    }

    /**
     * Flag to prevent multiple executions of the same intention
     * @type { boolean }
     */
    #started = false;
    
    /**
     * Execute this intention using available plans
     * Tries each plan in the library until one succeeds
     * @returns { Promise<any> } - Result of successful plan execution
     * @throws { Array } - Error if no plan can satisfy the intention
     */
    async achieve () {
        // Prevent multiple executions of the same intention
        if ( this.#started)
            return this;
        else
            this.#started = true;

        // Try each plan in the library until one succeeds
        for (const planClass of planLibrary) {
            // Check if intention has been stopped
            if ( this.stopped ) throw [ 'stopped intention', ...this.predicate ];

            // Check if this plan can handle this type of intention
            if ( planClass.isApplicableTo( ...this.predicate ) ) {
                // Create and execute the plan
                this.#current_plan = new planClass(this.#parent);
                this.log('achieving intention', ...this.predicate, 'with plan', planClass.name);
                
                try {
                    const plan_res = await this.#current_plan.execute( ...this.predicate );
                    this.log( 'successful intention', ...this.predicate, 'with plan', planClass.name, 'with result:', plan_res );
                    return plan_res
                } catch (error) {
                    // Plan failed - try the next one
                    this.log( 'failed intention', ...this.predicate,'with plan', planClass.name, 'with error:', error );
                }
            }
        }

        // Check again if stopped before throwing error
        if ( this.stopped ) throw [ 'stopped intention', ...this.predicate ];

        // No plan could satisfy this intention
        throw ['no plan satisfied the intention ', ...this.predicate ]
    }
}


/**
 * Library of available plans for executing intentions
 * @type { Array<typeof Plan> }
 */
const planLibrary = [];

/**
 * Base class for all plans that execute intentions
 * Provides common functionality for plan management and sub-intention handling
 */
class Plan {

    /**
     * Flag indicating if this plan has been stopped
     * @type { boolean }
     */
    #stopped = false;
    
    /**
     * Stop this plan and all its sub-intentions
     */
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
     * @type { IntentionRevision }
     */
    #parent;

    /**
     * Create a new plan with the given parent
     * @param { IntentionRevision } parent - The parent intention revision system
     */
    constructor ( parent ) {
        this.#parent = parent;
    }

    /**
     * Log messages with proper indentation
     * @param { ...any } args - Arguments to log
     */
    log ( ...args ) {
        if ( this.#parent && this.#parent.log )
            this.#parent.log( '\t', ...args )
    }

    /**
     * Array of sub-intentions that this plan manages
     * Multiple sub-intentions could potentially be executed in parallel
     * @type { Array<Intention> }
     */
    #sub_intentions = [];

    /**
     * Create and execute a sub-intention as part of this plan
     * @param { Array } predicate - The sub-intention predicate
     * @returns { Promise<any> } - Result of sub-intention execution
     */
    async subIntention ( predicate ) {
        const sub_intention = new Intention( this, predicate );
        this.#sub_intentions.push( sub_intention );
        return sub_intention.achieve();
    }

    /**
     * Execute this plan with the given parameters
     * Must be implemented by subclasses
     * @param { ...any } args - Plan-specific parameters
     * @returns { Promise<any> } - Result of plan execution
     */
    async execute( ...args ) {
        throw new Error('execute method must be implemented by subclasses');
    }

    /**
     * Check if this plan can handle the given intention type
     * Must be implemented by subclasses
     * @param { ...any } args - Intention parameters to check
     * @returns { boolean } - True if this plan can handle the intention
     */
    static isApplicableTo( ...args ) {
        throw new Error('isApplicableTo method must be implemented by subclasses');
    }
}

/**
 * Plan for picking up parcels at a specific location
 * Moves to the target position and attempts to pick up the parcel
 */
class GoPickUp extends Plan {

    /**
     * Check if this plan can handle go_pick_up intentions
     * @param { string } go_pick_up - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { string } id - Parcel ID
     * @param { Array } path - Path to the target
     * @returns { boolean } - True if this is a go_pick_up intention
     */
    static isApplicableTo ( go_pick_up, x, y, id, path ) {
        return go_pick_up == 'go_pick_up';
    }

    /**
     * Execute the pickup plan
     * @param { string } go_pick_up - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { string } id - Parcel ID
     * @param { Array } path - Path to the target
     * @returns { Promise<boolean> } - True if pickup was successful
     */
    async execute ( go_pick_up, x, y, id, path ) {
        if ( this.stopped ) throw ['stopped']; // Check if stopped
        await this.subIntention( ['go_to', x, y, path] ); // Move to target
        if ( this.stopped ) throw ['stopped']; // Check if stopped
        await client.emitPickup() // Attempt pickup
        return true;
    }
}

/**
 * Plan for delivering parcels to delivery points
 * Moves to the delivery location and attempts to put down parcels
 */
class GoDeliver extends Plan {

    /**
     * Check if this plan can handle go_deliver intentions
     * @param { string } go_deliver - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { Array } path - Path to the target
     * @returns { boolean } - True if this is a go_deliver intention
     */
    static isApplicableTo ( go_deliver, x, y, path ) {
        return go_deliver == 'go_deliver';
    }

    /**
     * Execute the delivery plan
     * @param { string } go_deliver - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { Array } path - Path to the target
     * @returns { Promise<boolean> } - True if delivery was successful
     */
    async execute ( go_deliver, x, y, path ) {
        if ( this.stopped ) throw ['stopped']; // Check if stopped
        await this.subIntention( ['go_to', x, y, path] ); // Move to target
        if ( this.stopped ) throw ['stopped']; // Check if stopped
        await client.emitPutdown() // Attempt delivery
        return true;
    }
}

/**
 * Plan for moving to a specific location using a path
 * Executes movement step by step along the provided path
 */
class BlindMove extends Plan {

    /**
     * Check if this plan can handle go_to intentions
     * @param { string } go_to - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { Array } path - Path to the target
     * @returns { boolean } - True if this is a go_to intention
     */
    static isApplicableTo ( go_to, x, y, path ) {
        return go_to == 'go_to';
    }

    /**
     * Execute the movement plan
     * @param { string } go_to - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { Array } path - Path to the target
     * @returns { Promise<boolean> } - True if movement was successful
     */
    async execute ( go_to, x, y, path ) {
        if (path && Array.isArray(path) && path.length > 1) {
            // Execute movement step by step along the path
            // Path is an array of node strings like '(x,y)'
            for (let i = 1; i < path.length; i++) {
                if (this.stopped) throw ['stopped'];
                
                // Parse target coordinates from path node
                const [targetX, targetY] = path[i].replace(/[()]/g, '').split(',').map(Number);
                
                // Calculate direction to move
                const dx = targetX - me.x;
                const dy = targetY - me.y;
                let moved = null;
                
                // Execute movement in the appropriate direction
                if (dx > 0) moved = await client.emitMove('right');
                else if (dx < 0) moved = await client.emitMove('left');
                else if (dy > 0) moved = await client.emitMove('up');
                else if (dy < 0) moved = await client.emitMove('down');
                
                if (moved) {
                    // Update agent position if movement was successful
                    me.x = moved.x;
                    me.y = moved.y;
                } else {
                    // Movement failed - agent is stuck
                    this.log('stucked');
                    throw 'stucked';
                }
            }
            return true;
        }
    }
}

/**
 * Plan for idle movement when no specific tasks are available
 * Prioritizes moving to strategic candidate positions, falls back to random movement
 */
class IdleMove extends Plan {

    /**
     * Available movement directions
     * @type { Array<string> }
     */
    static directions = ['up', 'right', 'down', 'left'];
    
    /**
     * Last direction used for movement
     * @type { number }
     */
    static LastDir = Math.floor(Math.random() * IdleMove.directions.length);
    
    /**
     * Previous cell visited to avoid immediate backtracking
     * @type { string }
     */
    static _prevCell = null;

    /**
     * Check if this plan can handle idle intentions
     * @param { string } idle - The intention type
     * @returns { boolean } - True if this is an idle intention
     */
    static isApplicableTo(idle) {
        return idle == 'idle';
    }

    /**
     * Execute the idle movement plan
     * @param { string } go_to - The intention type (unused)
     * @returns { Promise<boolean> } - True if movement was successful
     */
    async execute(go_to) {
        if (this.stopped) throw ['stopped'];
        
        let noCandidates = true;
        let bestCandidate = null;
        let bestCandidatePath = null;
        
        // First, try to move to strategic candidate positions
        if (candidates.length > 0) {
            // Sort candidates by lastSeen (oldest first) to prioritize unexplored areas
            const sortedCandidates = [...candidates].sort((a, b) => a.lastSeen - b.lastSeen);
            
            // Agent 2 uses reverse order for better coverage
            if (MY_AGENT_ID === AGENT2_ID) {
                sortedCandidates.reverse();
            }
            
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
            
            // Move to the best candidate if found
            if (!noCandidates) {
                await this.subIntention( ['go_to', bestCandidate.x, bestCandidate.y, bestCandidatePath] );
                return true;
            }
        }
        
        // Fallback to random movement if no candidates are reachable
        if(noCandidates){
            const x = me.x;
            const y = me.y;
            const currentNodeId = '(' + x + ',' + y + ')';
            const prevCell = IdleMove._prevCell;
            let foundMove = false;
            let skippedPrev = null;

            // Shuffle directions for equal chance of each direction
            const dirs = IdleMove.directions.slice();
            for (let i = dirs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
            }

            // Try all directions, avoiding the previous cell if possible
            for (const dir of dirs) {
                let [targetX, targetY] = [x, y];
                if (dir === 'up') targetY++;
                else if (dir === 'down') targetY--;
                else if (dir === 'left') targetX--;
                else if (dir === 'right') targetX++;
                const targetNodeId = '(' + targetX + ',' + targetY + ')';
                
                // Check if the target cell is accessible
                if (
                    global.graph &&
                    global.graph.has(currentNodeId) &&
                    global.graph.has(targetNodeId) &&
                    global.graph.get(currentNodeId).has(targetNodeId)
                ) {
                    // Skip the previous cell to avoid immediate backtracking
                    if (prevCell && targetNodeId === prevCell) {
                        skippedPrev = { dir, targetX, targetY, targetNodeId };
                        continue;
                    }
                    
                    // Attempt movement in the chosen direction
                    let moveResult = null;
                    switch (dir) {
                        case 'up': moveResult = await client.emitMove('up'); break;
                        case 'down': moveResult = await client.emitMove('down'); break;
                        case 'left': moveResult = await client.emitMove('left'); break;
                        case 'right': moveResult = await client.emitMove('right'); break;
                    }
                    
                    if (moveResult) {
                        // Movement successful - update tracking variables
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
                // No valid move found - remain idle and update direction
                IdleMove.LastDir = (IdleMove.LastDir + 1) % 4;
                IdleMove._prevCell = null;
            }
        }

        return true;
    }
}

/**
 * Plan for delivering parcels to the other agent
 * Handles inter-agent parcel transfer with collision avoidance
 */
class GoDeliverAgent extends Plan {
    
    /**
     * Check if this plan can handle go_deliver_agent intentions
     * @param { string } go_deliver_agent - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { Array } path - Path to the target
     * @returns { boolean } - True if this is a go_deliver_agent intention
     */
    static isApplicableTo(go_deliver_agent, x, y, path) {
        return go_deliver_agent == 'go_deliver_agent';
    }
    
    /**
     * Check if the agent can move away from the other agent after putdown
     * This prevents getting stuck in the same position
     * @returns { boolean } - True if movement is possible
     */
    canMoveAfterPutdown() {
        // Check if we can move away from the other agent in any direction
        const other = otherAgents.get(OTHER_AGENT_ID);
        if (!other || other.x === undefined || other.y === undefined) {
            return false;
        }
        
        // Determine which direction to move away from the other agent
        const directions = [];
        if (me.x < other.x) {
            directions.push('left');
        }
        else if (me.x > other.x) {
            directions.push('right');
        }
        else if (me.y < other.y) {
            directions.push('down');
        }
        else if (me.y > other.y) {
            directions.push('up');
        }
        
        // Check if any of these directions are valid moves
        for (const dir of directions) {
            let targetX = me.x, targetY = me.y;
            if (dir === 'up') targetY++;
            else if (dir === 'down') targetY--;
            else if (dir === 'left') targetX--;
            else if (dir === 'right') targetX++;
            
            // Check if the target cell is free in the graph
            const currentNodeId = '(' + me.x + ',' + me.y + ')';
            const targetNodeId = '(' + targetX + ',' + targetY + ')';
            if (
                global.graph &&
                global.graph.has(currentNodeId) &&
                global.graph.has(targetNodeId) &&
                global.graph.get(currentNodeId).has(targetNodeId)
            ) {
                return true; // Found at least one valid direction to move away
            }
        }
        
        return false; // No valid direction to move away
    }

    /**
     * Execute the agent-to-agent delivery plan
     * @param { string } go_deliver_agent - The intention type
     * @param { number } x - Target X coordinate
     * @param { number } y - Target Y coordinate
     * @param { Array } path - Path to the target
     * @returns { Promise<boolean> } - True if delivery was successful
     */
    async execute(go_deliver_agent, x, y, path) {
        if (this.stopped) throw ['stopped']; // Check if stopped
        await this.subIntention(['go_to', x, y, path]); // Move to target
        if (this.stopped) throw ['stopped']; // Check if stopped
        
        // Check distance to the other agent
        const other = otherAgents.get(OTHER_AGENT_ID);
        if (other && other.x !== undefined && other.y !== undefined) {
            const dist = utils.manhattanDistance(me, other);
            if (dist <= 4) {
                // Check if we can move after putting down parcels
                if (!this.canMoveAfterPutdown()) {
                    console.log('Cannot move after putdown, skipping delivery to other agent');
                    return true;
                }
                
                console.log('Can move after putdown, proceeding with delivery');
                
                // Put down all carried parcels and assign them to the other agent
                const parcelsToPick = Array.from(carriedParcels.keys());
                console.log('assigned parcels before putdown', otherAgentParcels);
                console.log('Parcels to pick', parcelsToPick);
                
                for (const parcelId of parcelsToPick) {
                    let parcel = freeParcels.get(parcelId);
                    if (parcel) {
                        freeParcels.delete(parcelId);
                    }
                    otherAgentParcels.add(parcelId);
                }
                
                await client.emitPutdown();
                if (this.stopped) throw ['stopped']; // Check if stopped
                console.log('assigned parcels after putdown', otherAgentParcels);
                
                // Move away from the drop location to avoid blocking the other agent
                const directions = [];
                if (me.x < other.x) {
                    directions.push('left');
                }
                else if (me.x > other.x) {
                    directions.push('right');
                }
                else if (me.y < other.y) {
                    directions.push('down');
                }
                else if (me.y > other.y) {
                    directions.push('up');
                }
                
                // Try to move in the calculated direction
                for (const dir of directions) {
                    let targetX = me.x, targetY = me.y;
                    if (dir === 'up') targetY++;
                    else if (dir === 'down') targetY--;
                    else if (dir === 'left') targetX--;
                    else if (dir === 'right') targetX++;
                    
                    // Check if the target cell is free in the graph
                    const currentNodeId = '(' + me.x + ',' + me.y + ')';
                    const targetNodeId = '(' + targetX + ',' + targetY + ')';
                    if (
                        global.graph &&
                        global.graph.has(currentNodeId) &&
                        global.graph.has(targetNodeId) &&
                        global.graph.get(currentNodeId).has(targetNodeId)
                    ) {
                        // Try to move
                        let moveResult = null;
                        switch (dir) {
                            case 'up': moveResult = await client.emitMove('up'); break;
                            case 'down': moveResult = await client.emitMove('down'); break;
                            case 'left': moveResult = await client.emitMove('left'); break;
                            case 'right': moveResult = await client.emitMove('right'); break;
                        }
                        if (moveResult) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                            break;
                        }
                    }
                }

                return true;
            }
        }
        
        // If not within distance, parcels are already put down but not assigned to other agent
        return true;
    }
}

// ============================================================================
// PLAN LIBRARY REGISTRATION AND AGENT INITIALIZATION
// ============================================================================

// Register all available plans in the library
planLibrary.push( GoPickUp )
planLibrary.push( GoDeliver )
planLibrary.push( BlindMove )
planLibrary.push( IdleMove )
planLibrary.push( GoDeliverAgent )

// Initialize the agent after all classes are defined
myAgent = new IntentionRevision();
myAgent.loop();