// ============================================================================
// UTILITY FUNCTIONS AND GLOBALS FOR MULTI-AGENT SYSTEM
// ============================================================================

import {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells, OTHER_AGENT_ID, otherAgentParcels} from "./MultiAgents.js";

// ============================================================================
// CONFIGURATION AND PARSING
// ============================================================================

/**
 * Parse duration strings like '1s', '2s', etc. to milliseconds
 * Used for decay interval and other time-based configuration
 * 'infinite' is treated as Infinity
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
// DISTANCE AND DECAY UTILITIES
// ============================================================================

/**
 * Calculate Manhattan distance between two cells
 * Uses rounded coordinates to handle floating-point positions
 */
function manhattanDistance( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}

/**
 * Decay parcel rewards over time based on the decay interval
 * Called periodically to reduce parcel values and remove expired parcels
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
// MAP AND GRAPH UTILITIES
// ============================================================================

/**
 * Create 2D tile array from flat tiles array
 * Identifies delivery points and generating cells during map processing
 */
function createTiles2D(width, height, tiles) {
    const tiles2D = [];
    for (let x = 0; x < width; x++) {
        tiles2D[x] = [];
        for (let y = 0; y < height; y++) {
            tiles2D[x][y] = null;
        }
    }
    // Fill the 2D array with tile data and update delivery/generating cells
    for (let tile of tiles) {
        tiles2D[tile.x][tile.y] = tile;
        if (tile.type === 2)
            deliveryCells.set("(" + tile.x + "," + tile.y + ")", tile);
        else if (tile.type === 1)
            generatingCells.set("(" + tile.x + "," + tile.y + ")", tile);
    }
    return tiles2D;
}

/**
 * Create navigation graph from 2D tile array
 * Builds adjacency graph for pathfinding and navigation
 */
function createGraphFromTiles(width, height, tiles2D) {
    const graph = new Map(); // nodeId -> Set of neighbor nodeIds
    const nodePositions = new Map(); // nodeId -> {x, y, type}
    // Add nodes for non-empty tiles
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
    // Add edges between adjacent nodes
    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            const tile = tiles2D[x][y];
            if (tile && tile.type !== 0) {
                const nodeId = "(" + x + "," + y + ")";
                // Check all 4 adjacent directions
                const directions = [
                    { dx: -1, dy: 0 }, // left
                    { dx: 1, dy: 0 },  // right
                    { dx: 0, dy: -1 }, // up
                    { dx: 0, dy: 1 }   // down
                ];
                for (let dir of directions) {
                    const nx = x + dir.dx;
                    const ny = y + dir.dy;
                    // Check bounds
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
// AGENT POSITION AND COLLISION UTILITIES
// ============================================================================

/**
 * Determine agent's occupied cells based on position
 * Handles both stationary and moving agents for collision detection
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
        // Agent is moving horizontally
        const floorX = Math.floor(x);
        const ceilX = Math.ceil(x);
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push("(" + floorX + "," + Math.floor(y) + ")");
        occupiedCells.push("(" + ceilX + "," + Math.floor(y) + ")");
    }
    if (isMovingY) {
        // Agent is moving vertically
        const floorY = Math.floor(y);
        const ceilY = Math.ceil(y);
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push("(" + Math.floor(x) + "," + floorY + ")");
        occupiedCells.push("(" + Math.floor(x) + "," + ceilY + ")");
    }
    // Remove duplicates
    return [...new Set(occupiedCells)];
}

/**
 * Determine agent's movement direction based on position
 * Returns direction for moving agents or 'stationary' for stopped agents
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
        return (x - floorX) < 0.5 ? 'left' : 'right';
    }
    if (isMovingY) {
        const floorY = Math.floor(y);
        return (y - floorY) < 0.5 ? 'down' : 'up';
    }
    return 'unknown';
}

/**
 * Temporarily block agent positions in the navigation graph
 * Removes occupied cells from the graph to prevent pathfinding through them
 */
function blockAgentPositions(agentId, occupiedCells) {
    if (!global.graph) return;
    for (let cell of occupiedCells) {
        if (global.graph.has(cell)) {
            // Remove all edges to this cell
            for (let [nodeId, neighbors] of global.graph) {
                neighbors.delete(cell);
            }
            // Remove this cell's edges
            global.graph.delete(cell);
        }
    }
}

/**
 * Unblock agent positions in the navigation graph
 * Restores previously blocked cells to the graph for pathfinding
 */
function unblockAgentPositions(agentId, occupiedCells) {
    if (!global.graph || !global.nodePositions) return;

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
                if (nx >= 0 && nx < global.mapWidth && ny >= 0 && ny < global.mapHeight) {
                    const neighborTile = global.tiles2D[nx][ny];
                    if (neighborTile && neighborTile.type !== 0) {
                        const neighborId = "(" + nx + "," + ny + ")";
                        if (global.graph.has(neighborId)) {
                            global.graph.get(cell).add(neighborId);
                            global.graph.get(neighborId).add(cell);
                        }
                    }
                }
            }
        }
    }
}

// ============================================================================
// PATHFINDING AND DELIVERY UTILITIES
// ============================================================================

/**
 * Dijkstra's shortest path algorithm
 * Finds the shortest path between two nodes in the navigation graph
 */
function dijkstra(startId, endId) {
    if (!global.graph) {
        return null;
    }
    const graph = global.graph;
    const distances = new Map();
    const previous = new Map();
    const visited = new Set();
    // Initialize distances
    for (let nodeId of graph.keys()) {
        distances.set(nodeId, Infinity);
    }
    distances.set(startId, 0);
    // Priority queue (simple implementation)
    const queue = [startId];
    while (queue.length > 0) {
        // Find node with minimum distance
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
        // Check neighbors
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
    // Reconstruct path
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
 * Find the closest delivery point from the current position
 * Returns the nearest reachable delivery point with path information
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
    // Check all delivery points
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
 * Check if a path is still valid (all nodes exist in graph)
 * Used to validate paths before attempting movement
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
// INTENTION AND SCORING UTILITIES
// ============================================================================

/**
 * Calculate score for different types of intentions
 * Used to prioritize intentions in the agent's decision-making
 */
function getScore ( predicate ) {
    if (!predicate) return;
    const type = predicate[0];
    if (type === 'go_deliver') {
        const x = predicate[1];
        const y = predicate[2];
        let deliveryPath = predicate[3];
        let deliveryReward = carriedValue();
        if (deliveryPath == null)   
            return -2;
        let deliveryDistance = deliveryPath.length;
        const decayInterval = !isFinite(config.PARCEL_DECADING_INTERVAL) ? 50000 : config.PARCEL_DECADING_INTERVAL;
        const moveDuration = config.MOVEMENT_DURATION || 200;
        const steps = deliveryDistance / (config.MOVEMENT_STEPS || 1);
        const deliveryTime = steps * moveDuration;
        const expectedDecay = deliveryTime / decayInterval;
        let overallDecay = 0;
        for (const [id, parcel] of carriedParcels) {
            if(parcel.reward < expectedDecay) overallDecay += parcel.reward;
            else overallDecay += expectedDecay;
        }
        let score = deliveryReward - overallDecay;
        return score;
    }
    if (type === 'go_pick_up') {
        const x = predicate[1];
        const y = predicate[2];
        let pickupPath = predicate[4];
        if (!pickupPath ) {
            return -2;
        }
        let pickupDistance = pickupPath.length;
        const p = freeParcels.get(predicate[3]);
        if (!p || typeof p.reward !== 'number' || typeof p.lastUpdate !== 'number') return -2;
        const reward = p.reward;
        const lastUpdate = p.lastUpdate;
        const timeSinceSeen = Date.now() - lastUpdate;
        const decayInterval = (!isFinite(config.PARCEL_DECADING_INTERVAL) || !config.PARCEL_DECADING_INTERVAL)
            ? 50000 : config.PARCEL_DECADING_INTERVAL;
        const decaySteps = Math.floor(timeSinceSeen / decayInterval);
        const moveDuration = config.MOVEMENT_DURATION || 200;
        const steps = pickupDistance / (config.MOVEMENT_STEPS || 1);
        const pickupTime = steps * moveDuration;
        const expectedDecay = pickupTime / decayInterval;
        const rewardEstimate = reward - decaySteps - expectedDecay;
        let score = rewardEstimate;
        return score;
    }
    if (type === 'idle')
    {
        return -1;
    }
    if (type === 'go_deliver_agent') {
        return 0;
    }
    return 0;
}

/**
 * Calculate total value of carried parcels
 * Returns sum of all carried parcel rewards
 */
function carriedValue() {
    return Array.from(carriedParcels.values()).reduce((sum, p) => sum + (p.reward || 0), 0);
}

/**
 * Check if an intention is still valid and achievable
 * Validates intentions based on current world state
 */
function stillValid (predicate) {
    const type = predicate[0];
    switch (type) {
        case 'go_pick_up':
            let id = predicate[3];
            let p = freeParcels.get(id);
            let pickupPath = predicate[4];
            if (p && p.carriedBy || p && pickupPath === null || otherAgentParcels.has(id)) return false;
            return true;
        case 'go_deliver':
            let deliveryPath = predicate[3];
            if (carriedParcels.size == 0 || deliveryPath === null   )
                return false;
            return true;
        case 'go_deliver_agent':
            // Check if we're still carrying parcels and the other agent is still available
            if (carriedParcels.size == 0) return false;
            const other = otherAgents.get(OTHER_AGENT_ID);
            if (!other || other.x === undefined || other.y === undefined) return false;
            return true;
        case 'idle':
            // If not carrying any parcels and there are no free parcels, remain idle
            // if (carriedParcels.size === 0 && freeParcels.size == 0)
            //     return true;
            // return false;
            return true;
        default:
            return false;
    }
}

/**
 * Check if a position is free of other agents
 * Used for collision detection and path validation
 */
function isFree(x, y) {
    for (const a of otherAgents.values()) {
        if (a.x == x && a.y == y) return false;
    }
    return true;
}

/**
 * Get shortest path between two points
 * Wrapper function for dijkstra algorithm with coordinate conversion
 * Usage: getShortestPath(startX, startY, endX, endY)
 */
function getShortestPath(startX, startY, endX, endY) {
    const startId = "(" + startX + "," + startY + ")";
    const endId = "(" + endX + "," + endY + ")";
    const result = dijkstra(startId, endId);
    if (!result) {
        return {cost: null, path: null, pathSize: null};
    }
    return result;
}

// ============================================================================
// EXPORTS
// ============================================================================

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
// export {parcelUpdate as parcelUpdate}
export {getScore as getScore}
export {carriedValue as carriedValue}
export {stillValid as stillValid}
export {isFree as isFree}