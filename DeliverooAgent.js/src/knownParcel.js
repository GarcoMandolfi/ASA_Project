import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080/',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImRjN2Q0MiIsIm5hbWUiOiJNb3J0ZVoiLCJyb2xlIjoidXNlciIsImlhdCI6MTc1MTU0NDM1NX0.F8r_xQkLdeBzklf5zTUbw_L_k5ZW1zWQv5JNCw2f-hw'
);

const beliefset = new Map();    // id -> {name, x, y, score}
const knownParcels = new Map();    // id -> {x, y, reward, lastUpdate}
const carryingParcels = new Map(); // id -> {reward, lastUpdate}
const deliveryPoints = new Map(); // id -> { x, y }


let DECAY_INTERVAL = 0;
let OBS_RANGE = 0;
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
    CLOCK = Number(config.CLOCK);
    MOVEMENT_DURATION = Number(config.MOVEMENT_DURATION);

    console.log('Clock:', CLOCK, 'ms');
    console.log('Movement duration:', MOVEMENT_DURATION, 'ms');
    console.log('Decay interval:', DECAY_INTERVAL, 'ms');
    console.log('Observation range:', OBS_RANGE, 'tiles');
});

// when map is received, update the delivery points
client.onMap((width, height, tiles) => {
    console.log('Map received:', width, height);

    deliveryPoints.clear(); // Clear previous entries
    // Create 2D array of tiles
    const tiles2D = [];
    for (let x = 0; x < width; x++) {
        tiles2D[x] = [];
        for (let y = 0; y < height; y++) {
            tiles2D[x][y] = null;
        }
    }
    
    // Process tiles and identify delivery points
    let tileid = 1;
    for (let tile of tiles) {
        // actually, tile.type is a number, but for some reason it is a string in the client file
        if (parseInt(tile.type) === 2) {
            deliveryPoints.set(tileid, { x: tile.x, y: tile.y });
            tileid++;
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
    
    // Visualize the 2D map
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

    // Create graph from tiles
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
    
    // Show graph statistics
    console.log(`\nGraph Statistics:`);
    console.log(`Total nodes: ${graph.size}`);
    let totalEdges = 0;
    for (let neighbors of graph.values()) {
        totalEdges += neighbors.size;
    }
    console.log(`Total edges: ${totalEdges / 2}`); // Divide by 2 since each edge is counted twice

    // Store the graph globally for on-demand pathfinding
    global.graph = graph;
    global.nodePositions = nodePositions;
    
    console.log(`Graph created with ${graph.size} nodes. Ready for pathfinding.`);

    printDeliveryPoints();
});

client.onYou(_me => {
    console.log('You:', _me);
    me = _me;  // now me.id is your agent id
    
    // Find best delivery point from current position
    if (global.graph) {
        findBestDeliveryPoint(me.x, me.y);
    }
});



// Function to automatically navigate to best delivery point
async function goToBestDeliveryPoint() {
    console.log('Starting navigation to best delivery point...');
    
    if (!global.graph) {
        console.log('Graph not ready yet. Please wait for map to load.');
        return;
    }
    
    const bestDelivery = findBestDeliveryPoint(me.x, me.y);
    
    if (!bestDelivery) {
        console.log('No reachable delivery points found.');
        return;
    }
    
    console.log(`\nNavigating to delivery point at (${bestDelivery.deliveryPoint.x}, ${bestDelivery.deliveryPoint.y})`);
    console.log(`Total distance: ${bestDelivery.distance} steps`);
    
    // Follow the complete path step by step
    for (let i = 1; i < bestDelivery.path.length; i++) {
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
    for (let a of agents) {
        beliefset.set(a.id, a);
    }

    let agentList = Array.from(beliefset.values())
        .map(({ name, x, y, score }) => `${name}(${score}):${x},${y}`)
        .join(' ');
    // console.log('Agents:', agentList);
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

