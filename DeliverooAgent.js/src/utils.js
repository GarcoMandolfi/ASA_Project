import {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells} from "./SingleAgent.js";



// Parse duration strings like '1s', '2s', etc. to milliseconds
// For now this is For Decay Interval only, but can be extended for other durations
// 'infinite' is treated as Infinity

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



//Simple Manhattan distance between two cells
function manhattanDistance( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}



// this function is used to decay the parcels
// it is called every time the agent updates its state
// it is used to decay the parcels based on the decay interval
function decayParcels() {
    let now = Date.now();

    for (let [id, parcel] of freeParcels) {
        const timePassed = now - parcel.lastUpdate;

        if (timePassed >= config.DECAY_INTERVAL) {
            const ticks = Math.floor(timePassed / config.DECAY_INTERVAL);
            const newReward = Math.max(1, parcel.reward - ticks);

            if (newReward <= 1) {
                freeParcels.delete(id);
                continue;
            }

            parcel.reward = newReward;
            parcel.lastUpdate += ticks * config.DECAY_INTERVAL;
            freeParcels.set(id, parcel);
        }
    }
}

// this function is used to get the key of the predicate
function getPredicateKey(predicate) {
    const [type, ...args] = predicate;

    switch (type) {
        case 'go_pick_up':
            return 'go_pick_up ' + args[2];
        case 'go_deliver':
            return 'go deliver ' + args[0] + ' ' + args[1]; // type:id
        default:
            return predicate.join(' '); // fallback to full string match
    }
}




// Helper function to create 2D tile array from flat tiles array
function createTiles2D(width, height, tiles) {
    const tiles2D = [];
    for (let x = 0; x < width; x++) {
        tiles2D[x] = [];
        for (let y = 0; y < height; y++) {
            tiles2D[x][y] = null;
        }
    }
    
    // Fill the 2D array with tile data
    for (let tile of tiles) {
        tiles2D[tile.x][tile.y] = tile;
        
        // Check for delivery points (type 2)
        if (tile.type === 2)
            deliveryCells.set("(" + tile.x + "," + tile.y + ")", tile);
        else if (tile.type === 3)
            generatingCells.set("(" + tile.x + "," + tile.y + ")", tile);
    }
    
    return tiles2D;
}


// Helper function to create graph from tiles
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



// Helper function to determine agent's occupied cells based on position
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
        const targetX = (x - floorX) < 0.5 ? floorX : ceilX;
        
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push("(" + floorX + "," + Math.floor(y) + ")");
        occupiedCells.push("(" + ceilX + "," + Math.floor(y) + ")");
    }
    
    if (isMovingY) {
        // Agent is moving vertically
        const floorY = Math.floor(y);
        const ceilY = Math.ceil(y);
        const targetY = (y - floorY) < 0.5 ? floorY : ceilY;
        
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push("(" + Math.floor(x) + "," + floorY + ")");
        occupiedCells.push("(" + Math.floor(x) + "," + ceilY + ")");
    }
    
    // Remove duplicates
    return [...new Set(occupiedCells)];
}


// Helper function to determine agent's movement direction
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


// Helper function to temporarily block agent positions in the graph
function blockAgentPositions(agentId, occupiedCells) {
    if (!global.graph) return;
    
    console.log(`Blocking positions for agent ${agentId}: ${occupiedCells.join(', ')}`);
    
    // Remove edges to/from occupied cells
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


// Helper function to unblock agent positions in the graph
function unblockAgentPositions(agentId, occupiedCells) {
    if (!global.graph || !global.nodePositions) return;
    
    console.log(`Unblocking positions for agent ${agentId}: ${occupiedCells.join(', ')}`);
    
    // For each occupied cell, restore it to the graph
    for (let cell of occupiedCells) {
        const [x, y] = cell.split(',').map(Number);
        
        // Check if this cell should be a valid node (not a wall)
        const tile = global.tiles2D[x][y];
        if (tile && tile.type !== 0) {
            // Add the cell back to the graph
            global.graph.set(cell, new Set());
            
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
                
                // Check bounds
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
        }
    }
}


// Helper function to check if an agent is within observation range
function isAgentInRange(agentX, agentY, myX, myY, AGENT_OBS_RANGE) {
    const dx = Math.abs(agentX - myX);
    const dy = Math.abs(agentY - myY);
    const distance = dx + dy; // Manhattan distance
    
    return distance < AGENT_OBS_RANGE;
}


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


function findClosestDelivery(x, y) {
    if (!global.graph) {
        return null;
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
        
        return null;
    }
}

// Function to check if a path is still valid (all nodes exist in graph)
function isPathValid(path) {
    if (!path || path.length === 0) return false;
    
    for (let nodeId of path) {
        if (!global.graph.has(nodeId)) {
            return false;
        }
    }
    return true;
}

function parcelUpdate(parcel) {
    if ( parcel.reward > 1 ) {
        freeParcels.set ( parcel.id, {
            ...parcel,
            lastSeen: Date.now()
        })
    }
    else
        freeParcels.delete(parcel.id);
}


function getScore ( predicate ) {

    const type = predicate[0];

    if (type == 'go_deliver') {

        const x = predicate[1];
        const y = predicate[2];
        let deliveryDistance = manhattanDistance ({x, y}, me);
        let deliveryReward = carriedValue();

        const decayInterval = !isFinite(config.DECAY_INTERVAL) ? 20 : config.DECAY_INTERVAL;
        const moveDuration = config.MOVE_DURATION || 200;
        const steps = deliveryDistance / (config.MOVE_STEPS || 1);
        const deliveryTime = steps * moveDuration;
        const expectedDecay = deliveryTime / decayInterval;

        let score = deliveryReward - deliveryDistance * 2 - expectedDecay;

        const pressure = carriedParcels.size / config.MAX_PARCELS;
        score += pressure * 10;

        score = Math.min(score, 0);

        return score;
    }

    if (type == 'go_pick_up') {
        
        const x = predicate[1];
        const y = predicate[2];

        const d = manhattanDistance({x, y}, me);
        const timeSinceSeen = Date.now() - predicate[5];
        const decaySteps = Math.floor(timeSinceSeen / config.DECAY_INTERVAL);
        const rewardEstimate = predicate[4] - decaySteps;

        const normalizedReward = Math.max(rewardEstimate, 0);
        const score = 2 * normalizedReward / (d + 1); // +1 to avoid division by zero

        return score;
    }

    if (type == 'idle')
        return -1;

    return 0;
}


function carriedValue() {
    return Array.from(carriedParcels.values()).reduce((sum, p) => sum + (p.reward || 0), 0);
}


function stillValid (predicate) {

    const type = predicate[0];

    switch (type) {
        case 'go_pick_up':
            let id = predicate[3];
            let p = freeParcels.get(id);
            if (p && p.carriedBy) return false;
            return true;
        case 'go_deliver':
            if (carriedParcels.size == 0)
                return false;
            return true;
        case 'idle':
            // If not carrying any parcels and there are no free parcels, remain idle
            if (carriedParcels.size === 0 && freeParcels.size == 0)
                return true;
            return false;
        default:
            return false;
    }

}


function isFree(x, y) {
    
    for (const a of otherAgents.values()) {
        if (a.x == x && a.y == y) return false;
    }

    return true;
}

export {decayParcels as decayParcels}
export {getPredicateKey as getKey}
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
export {isAgentInRange as isAgentInRange}
export {parcelUpdate as parcelUpdate}
export {getScore as getScore}
export {carriedValue as carriedValue}
export {stillValid as stillValid}
export {isFree as isFree}