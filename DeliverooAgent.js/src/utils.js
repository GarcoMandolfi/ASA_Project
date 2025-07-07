import { deliveryCells } from "./BDIagent.js";

// Update the reward of each parcel according to the decay interval
function decayParcels(parcelMap, now, decayInterval) {
    for (let [id, parcel] of parcelMap) {
        const timePassed = now - parcel.lastUpdate;

        if (timePassed >= decayInterval) {
            const ticks = Math.floor(timePassed / decayInterval);
            const newReward = Math.max(1, parcel.reward - ticks);

            if (newReward <= 1) {
                parcelMap.delete(id);
                continue;
            }

            parcel.reward = newReward;
            parcel.lastUpdate += ticks * decayInterval;
            parcelMap.set(id, parcel);
        }
    }
}

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
        if (tile.type === 2) {
            const id = `${tile.x},${tile.y}`;
            deliveryCells.set(id, { x: tile.x, y: tile.y });
        }
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
                const nodeId = `${x},${y}`;
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
                const nodeId = `${x},${y}`;
                
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
                            const neighborId = `${nx},${ny}`;
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
        return [`${Math.floor(x)},${Math.floor(y)}`];
    }
    
    const occupiedCells = [];
    
    if (isMovingX) {
        // Agent is moving horizontally
        const floorX = Math.floor(x);
        const ceilX = Math.ceil(x);
        const targetX = (x - floorX) < 0.5 ? floorX : ceilX;
        
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push(`${floorX},${Math.floor(y)}`);
        occupiedCells.push(`${ceilX},${Math.floor(y)}`);
    }
    
    if (isMovingY) {
        // Agent is moving vertically
        const floorY = Math.floor(y);
        const ceilY = Math.ceil(y);
        const targetY = (y - floorY) < 0.5 ? floorY : ceilY;
        
        // Agent occupies both the cell it's leaving and the cell it's entering
        occupiedCells.push(`${Math.floor(x)},${floorY}`);
        occupiedCells.push(`${Math.floor(x)},${ceilY}`);
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
                        const neighborId = `${nx},${ny}`;
                        
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

export {decayParcels as decayParcels}
export {getPredicateKey as getKey}