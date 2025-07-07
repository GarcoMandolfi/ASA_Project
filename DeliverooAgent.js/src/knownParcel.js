import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080/',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
);

const beliefset = new Map();    // id -> {name, x, y, score}
const knownParcels = new Map();    // id -> {x, y, reward, lastUpdate}
const carryingParcels = new Map(); // id -> {reward, lastUpdate}
const deliveryPoints = new Map(); // id -> { x, y }
const otherAgents = new Map(); // id -> {x, y, lastUpdate, isMoving, direction, occupiedCells}


let DECAY_INTERVAL = 0;
let OBS_RANGE = 0;
let AGENT_OBS_RANGE = 0;
let CLOCK = 0;
let MOVEMENT_DURATION = 0;
let me = { id: null, x: 0, y: 0 }; // store agent id too


// Parse duration strings like '1s', '2s', etc. to milliseconds
// For now this is For Decay Interval only, but can be extended for other durations
// 'infinite' is treated as Infinity

function parseDurationToMilliseconds(str) {
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

client.onConfig(config => {
    console.log("Received config:", config);

    DECAY_INTERVAL = parseDurationToMilliseconds(config.PARCEL_DECADING_INTERVAL);
    OBS_RANGE = Number(config.PARCELS_OBSERVATION_DISTANCE);
    AGENT_OBS_RANGE = Number(config.AGENTS_OBSERVATION_DISTANCE);
    CLOCK = Number(config.CLOCK);
    MOVEMENT_DURATION = Number(config.MOVEMENT_DURATION);

    console.log('Clock:', CLOCK, 'ms');
    console.log('Movement duration:', MOVEMENT_DURATION, 'ms');
    console.log('Decay interval:', DECAY_INTERVAL, 'ms');
    console.log('Parcel observation range:', OBS_RANGE, 'tiles');
    console.log('Agent observation range:', AGENT_OBS_RANGE, 'tiles');
});

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
            deliveryPoints.set(id, { x: tile.x, y: tile.y });
        }
    }
    
    return tiles2D;
}

// Helper function to visualize the map
function visualizeMap(width, height, tiles2D) {
    console.log('\nMap Visualization (2D):');
    console.log('Legend: 0=empty, 1=wall, 2=delivery, 3=spawn');
    console.log('─'.repeat(width * 2 + 1)); // Top border
    
    // reverse the y axis to match the map
    for (let y = height - 1; y >= 0; y--) {
        let row = '│';
        for (let x = 0; x < width; x++) {
            const tile = tiles2D[x][y];
            if (tile && tile.type !== undefined) {
                row += tile.type;
            } else {
                row += ' '; // Empty space
            }
            row += ' ';
        }
        row += '│';
        console.log(row);
    }
    console.log('─'.repeat(width * 2 + 1)); // Bottom border
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

// Helper function to print graph statistics
function printGraphStatistics(graph) {
    console.log(`\nGraph Statistics:`);
    console.log(`Total nodes: ${graph.size}`);
    let totalEdges = 0;
    for (let neighbors of graph.values()) {
        totalEdges += neighbors.size;
    }
    console.log(`Total edges: ${totalEdges / 2}`); // Divide by 2 since each edge is counted twice
}

// Helper function to determine agent's occupied cells based on position
function getAgentOccupiedCells(x, y) {
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
function getAgentDirection(x, y) {
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
function isAgentInRange(agentX, agentY, myX, myY) {
    const dx = Math.abs(agentX - myX);
    const dy = Math.abs(agentY - myY);
    const distance = dx + dy; // Manhattan distance
    
    return distance < AGENT_OBS_RANGE;
}

// Helper function to check if a position is empty (no agents at that position)
function isPositionEmpty(x, y, visibleAgents) {
    console.log(`    Checking if position (${x}, ${y}) is empty:`);
    for (let agent of visibleAgents) {
        console.log(`      Agent ${agent.id}: (${agent.x.toFixed(2)}, ${agent.y.toFixed(2)})`);
        if (agent.x === x && agent.y === y) {
            console.log(`      -> Position NOT empty (agent ${agent.id} is here)`);
            return false; // There's an agent at this position
        }
    }
    console.log(`      -> Position IS empty`);
    return true; // No agents at this position
}

// Helper function to print agent list
function printAgents() {
    const agentList = Array.from(otherAgents.entries())
        .map(([id, { x, y, lastUpdate, isMoving, direction, status }]) => {
            if (status === 'unknown') {
                return `${id}: [UNKNOWN POSITION] [${direction}] [${status}] - Last: ${new Date(lastUpdate).toLocaleTimeString()}`;
            } else if (status === 'out_of_range') {
                return `${id}: [OUT OF RANGE] (${x.toFixed(2)}, ${y.toFixed(2)}) [${direction}] [${status}] - Last: ${new Date(lastUpdate).toLocaleTimeString()}`;
            } else {
                return `${id}: (${x.toFixed(2)}, ${y.toFixed(2)}) [${direction}] [${status}] - Last: ${new Date(lastUpdate).toLocaleTimeString()}`;
            }
        })
        .join('\n  ');
    
    console.log('\n📋 Other Agents:');
    if (agentList) {
        console.log(`  ${agentList}`);
    } else {
        console.log('  No agents tracked');
    }
    console.log(`Total agents: ${otherAgents.size}`);
}

// Debug function to check what's at a specific position
function debugPosition(x, y, agents) {
    console.log(`\n🔍 Debug position (${x}, ${y}):`);
    console.log(`My position: (${me.x.toFixed(2)}, ${me.y.toFixed(2)})`);
    console.log(`Distance to position: ${Math.abs(x - me.x) + Math.abs(y - me.y)}`);
    console.log(`In observation range: ${isAgentInRange(x, y, me.x, me.y)}`);
    console.log(`Position empty: ${isPositionEmpty(x, y, agents)}`);
    console.log(`Visible agents at this position:`);
    for (let agent of agents) {
        if (agent.x === x && agent.y === y) {
            console.log(`  - ${agent.id}: (${agent.x.toFixed(2)}, ${agent.y.toFixed(2)})`);
        }
    }
}

// Function to check agent visibility and update their status
function checkAgentVisibility() {
    // Get all currently visible agents from beliefset
    const visibleAgents = Array.from(beliefset.values()).filter(agent => agent.id !== me.id);
    const visibleAgentIds = new Set(visibleAgents.map(agent => agent.id));
    
    console.log(`\n👁️ Checking agent visibility:`);
    console.log(`My position: (${me.x.toFixed(2)}, ${me.y.toFixed(2)})`);
    console.log(`Agent observation range: ${AGENT_OBS_RANGE}`);
    console.log(`Visible agents: ${visibleAgents.length}`);
    console.log(`Tracked agents: ${otherAgents.size}`);
    
    // Check each tracked agent
    for (let [agentId, agent] of otherAgents) {
        const distance = Math.abs(agent.x - me.x) + Math.abs(agent.y - me.y);
        const canSeeAgent = distance < AGENT_OBS_RANGE;
        const agentIsVisible = visibleAgentIds.has(agentId);
        
        console.log(`Agent ${agentId}: pos(${agent.x.toFixed(2)}, ${agent.y.toFixed(2)}) distance:${distance} canSee:${canSeeAgent} isVisible:${agentIsVisible}`);
        
        if (canSeeAgent) {
            if (agentIsVisible) {
                // Agent is visible - update last seen
                console.log(`✅ Agent ${agentId} is visible - updating last seen`);
                agent.lastUpdate = Date.now();
                agent.status = 'visible';
                otherAgents.set(agentId, agent);
            } else {
                // Can see the position but agent is not there - position is empty
                console.log(`❌ Agent ${agentId} position (${agent.x.toFixed(2)}, ${agent.y.toFixed(2)}) is empty - updating to unknown`);
                agent.status = 'unknown';
                agent.lastUpdate = Date.now();
                otherAgents.set(agentId, agent);
                
                // Unblock the position since it's empty
                if (agent.occupiedCells) {
                    unblockAgentPositions(agentId, agent.occupiedCells);
                }
            }
        } else {
            // Can't see the agent's position - mark as out of range but keep position
            if (agent.status === 'visible') {
                console.log(`🌫️ Agent ${agentId} out of range - keeping last known position`);
                agent.status = 'out_of_range';
                agent.lastUpdate = Date.now();
                otherAgents.set(agentId, agent);
                // Don't unblock position - we're keeping it as potentially occupied
            }
        }
    }
}

// when map is received, update the delivery points
client.onMap((width, height, tiles) => {
    console.log('Map received:', width, height);

    deliveryPoints.clear(); // Clear previous entries
    
    // Create 2D tile array and extract delivery points
    const tiles2D = createTiles2D(width, height, tiles);
    
    // Visualize the map
    visualizeMap(width, height, tiles2D);
    
    // Create graph from tiles
    const { graph, nodePositions } = createGraphFromTiles(width, height, tiles2D);
    
    // Print graph statistics
    printGraphStatistics(graph);
    
    // Store the graph and map data globally for on-demand pathfinding and graph recreation
    global.graph = graph;
    global.nodePositions = nodePositions;
    global.mapWidth = width;
    global.mapHeight = height;
    global.tiles2D = tiles2D;
    
    console.log(`Graph created with ${graph.size} nodes. Ready for pathfinding.`);

    printDeliveryPoints();
});

client.onYou(_me => {
    console.log('You:', _me);
    me = _me;  // now me.id is your agent id
    
    // Only compute pathfinding when agent is at integer coordinates (not moving)
    if (global.graph && Number.isInteger(me.x) && Number.isInteger(me.y)) {
        findBestDeliveryPoint(me.x, me.y);
    }
});



// Function to check if a path is still valid (all nodes exist in graph)
function isPathValid(path) {
    if (!path || path.length === 0) return false;
    
    for (let nodeId of path) {
        if (!global.graph.has(nodeId)) {
            console.log(`❌ Path invalid: node ${nodeId} not found in graph`);
            return false;
        }
    }
    return true;
}

// Function to recalculate best delivery path (for future use)
function recalculateBestDeliveryPath() {
    console.log('🔄 Recalculating best delivery path...');
    
    if (!global.graph) {
        console.log('Graph not ready yet. Please wait for map to load.');
        return null;
    }
    
    const bestDelivery = findBestDeliveryPoint(me.x, me.y);
    
    if (!bestDelivery) {
        console.log('No reachable delivery points found.');
        return null;
    }
    
    console.log(`New best delivery point: (${bestDelivery.deliveryPoint.x}, ${bestDelivery.deliveryPoint.y})`);
    console.log(`New distance: ${bestDelivery.distance} steps`);
    console.log(`New path: ${bestDelivery.path.join(' -> ')}`);
    
    return bestDelivery;
}

// Function to automatically navigate to best delivery point with path validation
async function goToBestDeliveryPoint() {
    console.log('Starting navigation to best delivery point...');
    
    if (!global.graph) {
        console.log('Graph not ready yet. Please wait for map to load.');
        return;
    }
    
    let bestDelivery = findBestDeliveryPoint(me.x, me.y);
    
    if (!bestDelivery) {
        console.log('No reachable delivery points found.');
        return;
    }
    
    console.log(`\nNavigating to delivery point at (${bestDelivery.deliveryPoint.x}, ${bestDelivery.deliveryPoint.y})`);
    console.log(`Total distance: ${bestDelivery.distance} steps`);
    
    // Follow the complete path step by step
    for (let i = 1; i < bestDelivery.path.length; i++) {
        // Check if current path is still valid before each move
        if (!isPathValid(bestDelivery.path)) {
            console.log('⚠️ Path blocked! Recalculating best path...');
            bestDelivery = recalculateBestDeliveryPath();
            
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
        
        console.log(`\nStep ${i}/${bestDelivery.path.length - 1}: Moving from (${me.x}, ${me.y}) to (${targetX}, ${targetY})`);
        
        // Calculate direction from current position to target
        const dx = targetX - me.x;
        const dy = targetY - me.y;
        
        if (dx > 0) {
            console.log('Moving right...');
            await client.emitMove('right');
        } else if (dx < 0) {
            console.log('Moving left...');
            await client.emitMove('left');
        } else if (dy > 0) {
            console.log('Moving up...');
            await client.emitMove('up');
        } else if (dy < 0) {
            console.log('Moving down...');
            await client.emitMove('down');
        } else {
            console.log('Already at target position, skipping...');
            continue;
        }
        
        // Wait for the move to complete and position to update
        // Use just the clock value for faster movement
        await new Promise(resolve => setTimeout(resolve, CLOCK));
        
        // Verify we reached the target (optional)
        console.log(`Current position after move: (${me.x}, ${me.y})`);
    }
    
    console.log('\n🎉 Arrived at delivery point!');
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

client.onAgentsSensing(agents => {
    const seenAgentIds = new Set();
    
    for (let a of agents) {
        beliefset.set(a.id, a);
        seenAgentIds.add(a.id);
        
        // Skip our own agent
        if (a.id === me.id) continue;
        

        
        const isMoving = !Number.isInteger(a.x) || !Number.isInteger(a.y);
        const direction = getAgentDirection(a.x, a.y);
        const occupiedCells = getAgentOccupiedCells(a.x, a.y);
        
        // Check if this is a new agent or if position has changed
        const existingAgent = otherAgents.get(a.id);
        const positionChanged = !existingAgent || 
                              existingAgent.x !== a.x || 
                              existingAgent.y !== a.y;
        
        if (existingAgent && positionChanged) {
            // Agent moved to a different position - unblock previous positions
            console.log(`Agent ${a.id} moved from (${existingAgent.x.toFixed(2)}, ${existingAgent.y.toFixed(2)}) to (${a.x.toFixed(2)}, ${a.y.toFixed(2)})`);
            if (existingAgent.occupiedCells) {
                unblockAgentPositions(a.id, existingAgent.occupiedCells);
            }
        }
        
        // Update or add agent information
        otherAgents.set(a.id, {
            x: a.x,
            y: a.y,
            lastUpdate: Date.now(),
            isMoving: isMoving,
            direction: direction,
            occupiedCells: occupiedCells,
            status: 'visible' // Mark as currently visible
        });
        
        // Block new positions only if agent is visible
        if (isAgentInRange(a.x, a.y, me.x, me.y)) {
            blockAgentPositions(a.id, occupiedCells);
        }
        
        if (!existingAgent) {
            console.log(`New agent detected: ${a.id} at (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) [${direction}]`);
        } else if (positionChanged) {
            console.log(`Agent ${a.id} position updated: (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) [${direction}]`);
        }
    }
    
    // Check all tracked agents for visibility
    for (let [agentId, agent] of otherAgents) {
        const distance = Math.abs(agent.x - me.x) + Math.abs(agent.y - me.y);
        const canSeeAgent = distance < AGENT_OBS_RANGE;
        const agentIsVisible = seenAgentIds.has(agentId);
        
        console.log(`Agent ${agentId}: pos(${agent.x.toFixed(2)}, ${agent.y.toFixed(2)}) distance:${distance} canSee:${canSeeAgent} isVisible:${agentIsVisible}`);
        
        if (canSeeAgent) {
            if (agentIsVisible) {
                // Agent is visible - update last seen
                console.log(`✅ Agent ${agentId} is visible - updating last seen`);
                agent.lastUpdate = Date.now();
                agent.status = 'visible';
                otherAgents.set(agentId, agent);
            } else {
                // Can see the position but agent is not there - position is empty
                console.log(`❌ Agent ${agentId} position (${agent.x.toFixed(2)}, ${agent.y.toFixed(2)}) is empty - updating to unknown`);
                agent.status = 'unknown';
                agent.lastUpdate = Date.now();
                otherAgents.set(agentId, agent);
                
                // Unblock the position since it's empty
                if (agent.occupiedCells) {
                    unblockAgentPositions(agentId, agent.occupiedCells);
                }
            }
        } else {
            // Can't see the agent's position - mark as out of range but keep position
            if (agent.status === 'visible') {
                console.log(`🌫️ Agent ${agentId} out of range - keeping last known position`);
                agent.status = 'out_of_range';
                agent.lastUpdate = Date.now();
                otherAgents.set(agentId, agent);
                // Don't unblock position - we're keeping it as potentially occupied
            }
        }
    }
    
    // Print updated agent list
    printAgents();
});

// Update the parcel in knownParcels
// If the reward is 1 or less, it is removed from knownParcels and carryingParcels
function updateExpiredParcel(parcel) {
    if (parcel.reward > 1) {
        knownParcels.set(parcel.id, {
            x: parcel.x,
            y: parcel.y,
            reward: parcel.reward,
            lastUpdate: Date.now()
        });
    } else {
        knownParcels.delete(parcel.id);
        // carryingParcels.delete(parcel.id);
    }
}

client.onParcelsSensing(parcels => {
    const seenNow = new Set(parcels.map(p => p.id));

    // Rebuild carryingParcels from scratch every time
    
    carryingParcels.clear();

    // Remove parcels that should be visible but aren't
    for (let [id, parcel] of knownParcels) {
        const dx = Math.abs(parcel.x - me.x);
        const dy = Math.abs(parcel.y - me.y);
        const distance = dx + dy;

        if (distance < OBS_RANGE && !seenNow.has(id)) {
            knownParcels.delete(id);
        }
    }

    for (let p of parcels) {
        beliefset.set(p.id, p);

        // If the parcel is not in the knownParcels, add it
        if (p.carriedBy === null) {
            updateExpiredParcel(p);
            continue;
        }

        // Fill carryingParcels with parcels currently carried by me
        if (p.carriedBy === me.id) {
            knownParcels.delete(p.id);
            carryingParcels.set(p.id, {
                reward: p.reward,
                lastUpdate: Date.now()
            });
            continue;
        }


        if (p.carriedBy !== null && p.carriedBy !== me.id  ) {
            // If the parcel is carried by someone else, remove it from knownParcels
            knownParcels.delete(p.id);
            continue;
        }
    }



    // printParcels();
});

// Handle parcel decay
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

// Periodically decay parcels every second
// This is a simple simulation of the decay process
setInterval(() => {
    if (!isFinite(DECAY_INTERVAL)) return;

    const now = Date.now();

    decayParcels(knownParcels, now, DECAY_INTERVAL);

    // printParcels();
}, 1000);


// Print the current state of known and carrying parcels
// This function is called after every update to knownParcels and carryingParcels

function printParcels() {
    const knownList = Array.from(knownParcels.entries())
        .map(([id, { x, y, reward }]) => `${id}(${reward}):${x},${y}`)
        .join(' ');

    const carryingList = Array.from(carryingParcels.entries())
        .map(([id, { reward }]) => `${id}(${reward})`)
        .join(' ');

    console.log('Known Parcels (tracked):', knownList);
    console.log('Carrying Parcels:', carryingList);
}

// Print the current state of delivery points
function printDeliveryPoints() {
    const list = Array.from(deliveryPoints.entries())
        .map(([id, { x, y }]) => `${id}: (${x},${y})    `)
        .join(' ');
    console.log('Delivery Points:', list);
}

// Dijkstra's algorithm for shortest path
function dijkstra(startId, endId) {
    if (!global.graph) {
        console.log('Graph not ready yet. Please wait for map to load.');
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

// Function to get shortest path between two points
// NOTE: This function is currently unused but kept as a utility function
// for future use. It can be called to get the shortest path between any two points.
// Usage: getShortestPath(startX, startY, endX, endY)
function getShortestPath(startX, startY, endX, endY) {
    const startId = `${startX},${startY}`;
    const endId = `${endX},${endY}`;
    
    const result = dijkstra(startId, endId);
    
    if (!result) {
        console.log(`No path exists between ${startId} and ${endId}.`);
        return null;
    }
    
    return result;
}

// Function to find best delivery point from a given position
function findBestDeliveryPoint(currentX, currentY) {
    if (!global.graph) {
        console.log('Graph not ready yet. Please wait for map to load.');
        return null;
    }
    
    const currentId = `${currentX},${currentY}`;
    
    if (!global.graph.has(currentId)) {
        console.log(`Invalid starting position: ${currentId} not found in graph.`);
        return null;
    }
    
    let bestDeliveryPoint = null;
    let shortestDistance = Infinity;
    let bestPath = null;
    let unreachableDeliveryPoints = [];
    let reachableDeliveryPoints = [];
    
    // Check all delivery points
    for (let [deliveryId, deliveryPos] of deliveryPoints) {
        if (!global.graph.has(deliveryId)) {
            console.log(`Warning: Delivery point ${deliveryId} not found in graph.`);
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
        console.log(`\nBest Delivery Point Found:`);
        console.log(`Position: (${bestDeliveryPoint.x}, ${bestDeliveryPoint.y})`);
        console.log(`Distance: ${shortestDistance} steps`);
        console.log(`Path: ${bestPath.join(' -> ')}`);
        console.log(`Path size: ${bestPath.length} nodes`);
        console.log(`Reachable delivery points: ${reachableDeliveryPoints.length}/${deliveryPoints.size}`);
        
        return {
            deliveryPoint: bestDeliveryPoint,
            distance: shortestDistance,
            path: bestPath,
            pathSize: bestPath.length
        };
    } else {
        console.log(`\n❌ No path exists to any delivery point from position (${currentX}, ${currentY})`);
        console.log(`Total delivery points: ${deliveryPoints.size}`);
        console.log(`Reachable delivery points: ${reachableDeliveryPoints.length}`);
        console.log(`Unreachable delivery points: ${unreachableDeliveryPoints.length}`);
        
        if (unreachableDeliveryPoints.length > 0) {
            console.log(`Unreachable delivery points: ${unreachableDeliveryPoints.join(', ')}`);
        }
        
        return null;
    }
}
