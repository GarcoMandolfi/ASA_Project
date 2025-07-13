// ============================================================================
// PLANNING UTILITIES
// Core utility functions for pathfinding, state management, and PDDL integration
// ============================================================================

import { PddlDomain } from "@unitn-asa/pddl-client";
import {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells} from "./PlanningAgent.js";
import {pddlBeliefSet, pddlDomain} from "./PlanningAgent.js";



// ============================================================================
// TIME AND DURATION UTILITIES
// ============================================================================

/**
 * Parse duration strings like '1s', '2s', etc. to milliseconds
 * Supports 'infinite' for no decay and seconds format (e.g., '5s' = 5000ms)
 * @param { string } str - Duration string to parse
 * @returns { number } - Duration in milliseconds (Infinity for 'infinite')
 * @throws { Error } - If format is invalid or unsupported
 */
function parseDecayInterval(str) {
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



// ============================================================================
// DISTANCE AND GEOMETRY UTILITIES
// ============================================================================

/**
 * Calculate Manhattan distance between two positions
 * Uses rounded coordinates to handle floating-point agent positions
 * @param { {x: number, y: number} } pos1 - First position
 * @param { {x: number, y: number} } pos2 - Second position
 * @returns { number } - Manhattan distance (sum of absolute differences)
 */
function manhattanDistance( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}



// ============================================================================
// PARCEL STATE MANAGEMENT
// ============================================================================

/**
 * Decay parcel rewards over time based on the configured decay interval
 * Called periodically to simulate parcel value degradation
 * Parcels with reward <= 1 are removed from the free parcels list
 */
function decayParcels() {
    let now = Date.now();

    for (let [id, parcel] of freeParcels) {
        const timePassed = now - parcel.lastUpdate;

        if (timePassed >= config.PARCEL_DECADING_INTERVAL) {
            const ticks = Math.floor(timePassed / config.PARCEL_DECADING_INTERVAL);
            const newReward = Math.max(1, parcel.reward - ticks);

            if (newReward <= 1) {
                freeParcels.delete(id);
                continue;
            }

            parcel.reward = newReward;
            parcel.lastUpdate += ticks * config.PARCEL_DECADING_INTERVAL;
            freeParcels.set(id, parcel);
        }
    }
}


// ============================================================================
// MAP AND TILE PROCESSING
// ============================================================================

/**
 * Create 2D tile array from flat tiles array and initialize PDDL beliefs
 * Processes map tiles and sets up PDDL domain knowledge for pathfinding
 * @param { number } width - Map width
 * @param { number } height - Map height
 * @param { Array } tiles - Flat array of tile objects
 * @returns { Array<Array> } - 2D array of tiles indexed by [x][y]
 */
function createTiles2D(width, height, tiles) {
    const tiles2D = [];
    for (let x = 0; x < width; x++) {
        tiles2D[x] = [];
        for (let y = 0; y < height; y++) {
            tiles2D[x][y] = null;
        }
    }
    
    // Fill the 2D array with tile data and initialize PDDL beliefs
    for (let tile of tiles) {
        tiles2D[tile.x][tile.y] = tile;
        
        // Add non-wall tiles to PDDL domain
        if (tile.type != 0) {
            pddlBeliefSet.addObject("Tile_" + tile.x + "_" + tile.y);
            pddlBeliefSet.declare("tile Tile_" + tile.x + "_" + tile.y);
            pddlBeliefSet.declare("traversable Tile_" + tile.x + "_" + tile.y);
        }
        else continue;

        // Identify delivery points (type 2) and generating cells (type 1)
        if (tile.type === 2) {
            deliveryCells.set("(" + tile.x + "," + tile.y + ")", tile);
            pddlBeliefSet.declare("delivery Tile_" + tile.x + "_" + tile.y);
        }
        else if (tile.type === 1)
            generatingCells.set("(" + tile.x + "," + tile.y + ")", tile);

        // Establish spatial relationships for PDDL planning
        let right = tiles.find(t => t.x == tile.x + 1 && t.y == tile.y);
        if (right && right.type != 0) {
            pddlBeliefSet.declare("right Tile_" + right.x + "_" + right.y + " Tile_" + tile.x + "_" + tile.y);
            pddlBeliefSet.declare("left Tile_" + tile.x + "_" + tile.y + " Tile_" + right.x + "_" + right.y);
        }

        let up = tiles.find(t => t.x == tile.x && t.y == tile.y + 1);
        if (up && up.type != 0) {
            pddlBeliefSet.declare("up Tile_" + up.x + "_" + up.y + " Tile_" + tile.x + "_" + tile.y);
            pddlBeliefSet.declare("down Tile_" + tile.x + "_" + tile.y + " Tile_" + up.x + "_" + up.y);
        }
    }

    return tiles2D;
}


/**
 * Create navigation graph from 2D tile array for pathfinding
 * Builds adjacency graph for efficient shortest path calculations
 * @param { number } width - Map width
 * @param { number } height - Map height
 * @param { Array<Array> } tiles2D - 2D array of tiles
 * @returns { {graph: Map, nodePositions: Map} } - Navigation graph and position mapping
 */
function createGraphFromTiles(width, height, tiles2D) {
    const graph = new Map(); // nodeId -> Set of neighbor nodeIds
    const nodePositions = new Map(); // nodeId -> {x, y, type}
    
    // Add nodes for all traversable tiles (non-wall tiles)
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const tile = tiles2D[x][y];
            if (tile && tile.type !== 0) {
                const nodeId = "(" + x + "," + y + ")";
                graph.set(nodeId, new Set());
                nodePositions.set(nodeId, { x, y, type: tile.type });
            }
        }
    }
    
    // Add edges between adjacent traversable nodes
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const tile = tiles2D[x][y];
            if (tile && tile.type !== 0) {
                const nodeId = "(" + x + "," + y + ")";
                
                // Check all 4 adjacent directions (left, right, up, down)
                const directions = [
                    { dx: -1, dy: 0 }, // left
                    { dx: 1, dy: 0 },  // right
                    { dx: 0, dy: -1 }, // up
                    { dx: 0, dy: 1 }   // down
                ];
                
                for (let dir of directions) {
                    const nx = x + dir.dx;
                    const ny = y + dir.dy;
                    
                    // Check map bounds
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        const neighborTile = tiles2D[nx][ny];
                        if (neighborTile && neighborTile.type !== 0) {
                            const neighborId = "(" + nx + "," + ny + ")";
                            graph.get(nodeId).add(neighborId);
                        }
                    }
                }
            }
        }
    }
    
    return { graph, nodePositions };
}



// ============================================================================
// AGENT POSITION AND MOVEMENT UTILITIES
// ============================================================================

/**
 * Determine which cells an agent occupies based on its position
 * Handles both stationary and moving agents (with floating-point coordinates)
 * @param { {x: number, y: number} } agent - Agent with x, y coordinates
 * @returns { Array<string> } - Array of cell IDs the agent occupies
 */
function getAgentOccupiedCells(agent) {
    let x = agent.x;
    let y = agent.y;

    const isMovingX = !Number.isInteger(x);
    const isMovingY = !Number.isInteger(y);
    
    if (!isMovingX && !isMovingY) {
        // Agent is stationary, only occupies one cell
        return ["(" + Math.floor(x) + "," + Math.floor(y) + ")"];
    }
    
    const occupiedCells = [];
    
    if (isMovingX) {
        // Agent is moving horizontally - occupies both source and destination cells
        const floorX = Math.floor(x);
        const ceilX = Math.ceil(x);
        const targetX = (x - floorX) < 0.5 ? floorX : ceilX;
        
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push("(" + floorX + "," + Math.floor(y) + ")");
        occupiedCells.push("(" + ceilX + "," + Math.floor(y) + ")");
    }
    
    if (isMovingY) {
        // Agent is moving vertically - occupies both source and destination cells
        const floorY = Math.floor(y);
        const ceilY = Math.ceil(y);
        const targetY = (y - floorY) < 0.5 ? floorY : ceilY;
        
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push("(" + Math.floor(x) + "," + floorY + ")");
        occupiedCells.push("(" + Math.floor(x) + "," + ceilY + ")");
    }
    
    // Remove duplicates and return unique occupied cells
    return [...new Set(occupiedCells)];
}


/**
 * Determine the direction an agent is moving based on its position
 * Uses floating-point coordinates to determine movement direction
 * @param { {x: number, y: number} } agent - Agent with x, y coordinates
 * @returns { string } - Movement direction: 'stationary', 'left', 'right', 'up', 'down', or 'unknown'
 */
function getAgentDirection(agent) {
    let x = agent.x;
    let y = agent.y;

    const isMovingX = !Number.isInteger(x);
    const isMovingY = !Number.isInteger(y);
    
    if (!isMovingX && !isMovingY) {
        return 'stationary';
    }
    
    if (isMovingX) {
        const floorX = Math.floor(x);
        const ceilX = Math.ceil(x);
        return (x - floorX) < 0.5 ? 'left' : 'right';
    }
    
    if (isMovingY) {
        const floorY = Math.floor(y);
        const ceilY = Math.ceil(y);
        return (y - floorY) < 0.5 ? 'down' : 'up';
    }
    
    return 'unknown';
}


// ============================================================================
// GRAPH MODIFICATION FOR COLLISION AVOIDANCE
// ============================================================================

/**
 * Temporarily block agent positions in the navigation graph
 * Removes occupied cells from pathfinding to prevent collisions
 * Also updates PDDL beliefs to reflect blocked tiles
 * @param { string } agentId - ID of the agent occupying cells
 * @param { Array<string> } occupiedCells - Array of cell IDs the agent occupies
 */
function blockAgentPositions(agentId, occupiedCells) {
    if (!global.graph) return;
    
    // Remove edges to/from occupied cells to prevent pathfinding through them
    for (let cell of occupiedCells) {
        if (global.graph.has(cell)) {
            // Remove all edges to this cell from other nodes
            for (let [nodeId, neighbors] of global.graph) {
                neighbors.delete(cell);
            }
            // Remove this cell's edges
            global.graph.delete(cell);
        }
        // Update PDDL beliefs to mark tile as non-traversable
        const [cellX, cellY] = cell.replace(/[()]/g, '').split(',').map(Number);
        pddlBeliefSet.undeclare("traversable Tile_" + cellX + "_" + cellY);
    }
}


/**
 * Restore agent positions in the navigation graph after movement
 * Re-adds previously blocked cells and their edges to the pathfinding graph
 * Also updates PDDL beliefs to reflect newly traversable tiles
 * @param { string } agentId - ID of the agent that was occupying cells
 * @param { Array<string> } occupiedCells - Array of cell IDs to unblock
 */
function unblockAgentPositions(agentId, occupiedCells) {
    if (!global.graph || !global.nodePositions) return;
    
    // First pass: add cells back to the graph structure
    for (let cell of occupiedCells) {
        // Remove parentheses and split to get x and y as numbers
        const [x, y] = cell.replace(/[()]/g, '').split(',').map(Number);
        
        // Check if this cell should be a valid node (not a wall)
        const tile = global.tiles2D[x][y];
        if (tile && tile.type !== 0) {
            // Add the cell back to the graph
            global.graph.set(cell, new Set());
        }
    }

    // Second pass: restore edges to adjacent cells
    for (let cell of occupiedCells) {
        // Remove parentheses and split to get x and y as numbers
        const [x, y] = cell.replace(/[()]/g, '').split(',').map(Number);
        
        // Check if this cell should be a valid node (not a wall)
        const tile = global.tiles2D[x][y];
        if (tile && tile.type !== 0) {
            
            // Add edges to adjacent cells that are also unblocked
            const directions = [
                { dx: -1, dy: 0 }, // left
                { dx: 1, dy: 0 },  // right
                { dx: 0, dy: -1 }, // up
                { dx: 0, dy: 1 }   // down
            ];
            
            for (let dir of directions) {
                const nx = x + dir.dx;
                const ny = y + dir.dy;
                
                // Check map bounds
                if (nx >= 0 && nx < global.mapWidth && ny >= 0 && ny < global.mapHeight) {
                    const neighborTile = global.tiles2D[nx][ny];
                    if (neighborTile && neighborTile.type !== 0) {
                        const neighborId = "(" + nx + "," + ny + ")";
                        
                        // Only add edge if neighbor exists in graph (not blocked)
                        if (global.graph.has(neighborId)) {
                            global.graph.get(cell).add(neighborId);
                            global.graph.get(neighborId).add(cell);
                        }
                    }
                }
            }

            // Update PDDL beliefs to mark tile as traversable
            const [cellX, cellY] = cell.replace(/[()]/g, '').split(',').map(Number);
            pddlBeliefSet.declare("traversable Tile_" + cellX + "_" + cellY);
        }
    }
}

// ============================================================================
// PATHFINDING ALGORITHMS
// ============================================================================

/**
 * Dijkstra's shortest path algorithm implementation
 * Finds the shortest path between two nodes in the navigation graph
 * @param { string } startId - Starting node ID (format: "(x,y)")
 * @param { string } endId - Ending node ID (format: "(x,y)")
 * @returns { {cost: number, path: Array<string>, pathSize: number} | null } - Path result or null if no path exists
 */
function dijkstra(startId, endId) {
    if (!global.graph) {
        return null;
    }
    
    const graph = global.graph;
    const distances = new Map();
    const previous = new Map();
    const visited = new Set();
    
    // Initialize all distances to infinity
    for (let nodeId of graph.keys()) {
        distances.set(nodeId, Infinity);
    }
    distances.set(startId, 0);
    
    // Priority queue (simple implementation using array)
    const queue = [startId];
    
    while (queue.length > 0) {
        // Find node with minimum distance in queue
        let currentId = queue[0];
        let minDist = distances.get(currentId);
        
        for (let nodeId of queue) {
            const dist = distances.get(nodeId);
            if (dist < minDist) {
                minDist = dist;
                currentId = nodeId;
            }
        }
        
        // Remove current node from queue
        queue.splice(queue.indexOf(currentId), 1);
        
        if (currentId === endId) {
            break; // Found target
        }
        
        if (visited.has(currentId)) {
            continue;
        }
        
        visited.add(currentId);
        
        // Process neighbors of current node
        const neighbors = graph.get(currentId);
        if (!neighbors) continue;
        for (let neighborId of neighbors) {
            if (visited.has(neighborId)) continue;
            
            const newDist = distances.get(currentId) + 1; // Each step costs 1
            if (newDist < distances.get(neighborId)) {
                distances.set(neighborId, newDist);
                previous.set(neighborId, currentId);
                if (!queue.includes(neighborId)) {
                    queue.push(neighborId);
                }
            }
        }
    }
    
    // Reconstruct path from end to start
    const path = [];
    let currentId = endId;
    while (currentId !== startId) {
        path.unshift(currentId);
        currentId = previous.get(currentId);
        if (!currentId) {
            return null; // No path found
        }
    }
    path.unshift(startId);
    
    return {
        cost: distances.get(endId),
        path: path,
        pathSize: path.length
    };
}


/**
 * Find the closest delivery point to the given position
 * Evaluates all delivery points and returns the one with shortest path
 * @param { number } x - Current X coordinate
 * @param { number } y - Current Y coordinate
 * @returns { {deliveryPoint: Object, distance: number, path: Array<string>, pathSize: number} | {cost: null, path: null, pathSize: null} } - Best delivery option or null if none reachable
 */
function findClosestDelivery(x, y) {
    if (!global.graph) {
        return {cost: null, path: null, pathSize: null};
    }
    
    const currentId = "(" + x + "," + y + ")";
    
    if (!global.graph.has(currentId)) {
        return null;
    }
    
    let bestDeliveryPoint = null;
    let shortestDistance = Infinity;
    let bestPath = null;
    let unreachableDeliveryPoints = [];
    let reachableDeliveryPoints = [];
    
    // Evaluate all delivery points to find the closest one
    for (let [deliveryId, deliveryPos] of deliveryCells) {
        if (!global.graph.has(deliveryId)) {
            unreachableDeliveryPoints.push(deliveryId);
            continue;
        }
        
        const pathResult = dijkstra(currentId, deliveryId);
        
        if (pathResult && pathResult.cost < shortestDistance) {
            shortestDistance = pathResult.cost;
            bestDeliveryPoint = deliveryPos;
            bestPath = pathResult.path;
            reachableDeliveryPoints.push(deliveryId);
        } else if (!pathResult) {
            unreachableDeliveryPoints.push(deliveryId);
        } else {
            reachableDeliveryPoints.push(deliveryId);
        }
    }
    
    if (bestDeliveryPoint) {
        return {
            deliveryPoint: bestDeliveryPoint,
            distance: shortestDistance,
            path: bestPath,
            pathSize: bestPath.length
        };
    } else {
        return {cost: null, path: null, pathSize: null};
    }
}

/**
 * Check if a path is still valid (all nodes exist in the current graph)
 * Used to validate cached paths after graph modifications (e.g., agent movements)
 * @param { Array<string> } path - Array of node IDs representing the path
 * @returns { boolean } - True if all nodes in the path exist in the graph
 */
function isPathValid(path) {
    if (!path || path.length === 0) return false;
    
    for (let nodeId of path) {
        if (!global.graph.has(nodeId)) {
            return false;
        }
    }
    return true;
}

// ============================================================================
// PARCEL STATE MANAGEMENT
// ============================================================================

/**
 * Update parcel information in the free parcels map
 * Adds or updates parcel data, removes parcels with reward <= 1
 * @param { Object } parcel - Parcel object with id, reward, and other properties
 */
function parcelUpdate(parcel) {
    if ( parcel.reward > 1 ) {
        freeParcels.set ( parcel.id, {
            ...parcel,
            lastUpdate: Date.now()
        })
    }
    else
        freeParcels.delete(parcel.id);
}


// ============================================================================
// INTENTION SCORING AND EVALUATION
// ============================================================================

/**
 * Calculate priority score for an intention based on its type and parameters
 * Higher scores indicate more valuable actions to perform
 * @param { Array } predicate - Intention predicate (e.g., ['go_pick_up', x, y, id, path])
 * @returns { number } - Priority score (higher is better, negative for invalid actions)
 */
function getScore ( predicate ) {

    if (!predicate) return;
    const type = predicate[0];

    if (type === 'go_deliver') {
        // Score delivery intentions based on reward vs. decay during travel
        const x = predicate[1];
        const y = predicate[2];
        let deliveryDistance = getShortestPath ( me.x, me.y, x, y).cost;
        let deliveryReward = carriedValue();
        if (deliveryDistance == null)   
            return -2;

        // Calculate expected decay during delivery time
        const decayInterval = !isFinite(config.PARCEL_DECADING_INTERVAL) ? 20 : config.PARCEL_DECADING_INTERVAL;
        const moveDuration = config.MOVEMENT_DURATION || 200;
        const steps = deliveryDistance / (config.MOVEMENT_STEPS || 1);
        const deliveryTime = steps * moveDuration;
        const expectedDecay = deliveryTime / decayInterval;

        // Calculate total decay for all carried parcels
        let overallDecay = 0;
        for (const [id, parcel] of carriedParcels) {
            if(parcel.reward < expectedDecay) overallDecay += parcel.reward;
            else overallDecay += expectedDecay;
        }

        let score = deliveryReward - overallDecay;
        score = Math.max(score, 0);

        return score;
    }

    if (type === 'go_pick_up') {
        // Score pickup intentions based on reward vs. travel time and current decay
        const x = predicate[1];
        const y = predicate[2];

        const pickupDistance = getShortestPath ( me.x, me.y, x, y).cost;
        if (pickupDistance == null) {
            return -2;
        }
        const p = freeParcels.get(predicate[3]);
        if (!p) return;
        const reward = p.reward;
        const lastUpdate = p.lastUpdate;
        const timeSinceSeen = Date.now() - lastUpdate;
        const decaySteps = Math.floor(timeSinceSeen / config.PARCEL_DECADING_INTERVAL);

        // Calculate expected decay during pickup time
        const decayInterval = !isFinite(config.PARCEL_DECADING_INTERVAL) ? 20 : config.PARCEL_DECADING_INTERVAL;
        const moveDuration = config.MOVEMENT_DURATION || 200;
        const steps = pickupDistance / (config.MOVEMENT_STEPS || 1);
        const pickupTime = steps * moveDuration;
        const expectedDecay = pickupTime / decayInterval;

        const rewardEstimate = reward - decaySteps - expectedDecay;
        const score = Math.max(rewardEstimate, 0);

        return score;
    }

    if (type === 'idle') {
        return -1; // Lowest priority for idle actions
    }

    return 0;
}


/**
 * Calculate the total value of all parcels currently carried by the agent
 * @returns { number } - Sum of rewards for all carried parcels
 */
function carriedValue() {
    return Array.from(carriedParcels.values()).reduce((sum, p) => sum + (p.reward || 0), 0);
}


/**
 * Check if an intention is still valid and achievable
 * Validates that the conditions for the intention still exist
 * @param { Array } predicate - Intention predicate to validate
 * @returns { boolean } - True if the intention is still valid
 */
function stillValid (predicate) {

    const type = predicate[0];

    switch (type) {
        case 'go_pick_up':
            let id = predicate[3];
            let p = freeParcels.get(id);
            let pickupPath = predicate[4];
            // Invalid if parcel is carried by someone or path is null
            if (p && p.carriedBy || p && pickupPath === null) return false;
            return true;
        case 'go_deliver':
            let deliveryPath = predicate[3];
            // Invalid if not carrying parcels or delivery path is null
            if (carriedParcels.size == 0 || deliveryPath === null)
                return false;
            return true;
        case 'idle':
            // Valid to remain idle if not carrying parcels and no free parcels available
            if (carriedParcels.size === 0 && freeParcels.size == 0)
                return true;
            return false;
        default:
            return false;
    }
}



// Function to get shortest path between two points
// for future use. It can be called to get the shortest path between any two points.
// Usage: getShortestPath(startX, startY, endX, endY)
function getShortestPath(startX, startY, endX, endY) {
    const startId = "(" + startX + "," + startY + ")";
    const endId = "(" + endX + "," + endY + ")";
    
    const result = dijkstra(startId, endId);
    
    if (!result) {
        return {cost: null, path: null, pathSize: null};
    }
    
    return result;
}

function updateBeliefPosition(prevX, prevY) {
    if (prevX && prevY)
        pddlBeliefSet.undeclare("at Tile_" + prevX + "_" + prevY);
    pddlBeliefSet.declare("at Tile_" + Math.ceil(me.x) + "_" + Math.ceil(me.y));
    return [Math.ceil(me.x), Math.ceil(me.y)];
}

function pddlRemoveDoublePredicates() {

    const uniqePreds = new Set();

    pddlDomain.predicates = pddlDomain.predicates.filter(predicate => {
        const name = predicate.split(' ')[0]; // e.g. 'at' from 'at ?A'
        if (uniqePreds.has(name)) return false;
        uniqePreds.add(name);
        return true;
    })

}



export {getShortestPath as getShortestPath}
export {decayParcels as decayParcels}
export {parseDecayInterval as parseDecayInterval}
export {manhattanDistance as manhattanDistance}
export {createTiles2D as createTiles2D}
export {createGraphFromTiles as createGraphFromTiles}
export {dijkstra as dijkstra}
export {findClosestDelivery as findClosestDelivery}
export {isPathValid as isPathValid}
export {getAgentDirection as getAgentDirection}
export {getAgentOccupiedCells as getAgentOccupiedCells}
export {blockAgentPositions as blockAgentPositions}
export {unblockAgentPositions as unblockAgentPositions}
export {parcelUpdate as parcelUpdate}
export {getScore as getScore}
export {carriedValue as carriedValue}
export {stillValid as stillValid}
export {updateBeliefPosition as updateBeliefPosition}
export {pddlRemoveDoublePredicates as pddlRemoveDoublePredicates}