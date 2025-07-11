import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";
import * as utils from "./mUtils.js"
/*

*/
// Get agent number from command line arguments
const agentNumber = process.argv[2] || '1'; // Default to agent 1 if no argument provided
const AGENT1_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjIwNTE2NiIsIm5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSAxIiwidGVhbUlkIjoiNWUxNmRlIiwidGVhbU5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzUyMTQ5Mzg1fQ.eyiEl2lqQ0ez1ZWdkRIz4QCJh-hZA6EFi3B-0Yp9Cg0'
const AGENT2_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjU1ZTA0ZSIsIm5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSAyIiwidGVhbUlkIjoiMmJmYmZiIiwidGVhbU5hbWUiOiJBbmRpYW1vIGHCoHNjaWFyZSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzUyMTQ5MzkyfQ.TJ8TUSPjzaEP1Sq79ejqSxA33ZaH-fcf32goUuLLQHA'

/*

also, now i want to also implement something that every time you recieved the message from the other agent( with that id) ,
 first decode it and make 2 variables called recieved freeParcells and received otherAgents, decode the message info to them.
  then you should do two loops for freeparcels and otheragents. and check the lastseens. for freeParcels if the recieved data's 
  last seen was higher ( it seen more recently) then update the value of the 
  corresponding parcel in our freeparcel with the recieved ones.
   and for otheragents, except  for our own agent, (can be checked by id) update information about other agents as well
   ( and ofcource if nesessary it should handle the occupiedcells and block , unblock graphs.) 
*/ 


// Select token based on agent number
const selectedToken = agentNumber === '1' ? AGENT1_TOKEN : AGENT2_TOKEN;
// console.log(`Starting agent ${agentNumber} with token: ${selectedToken.substring(0, 50)}...`);

// Helper to extract agent id from JWT token
function extractAgentId(token) {
    const payload = token.split('.')[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded).id;
}

const AGENT1_ID = extractAgentId(AGENT1_TOKEN);
const AGENT2_ID = extractAgentId(AGENT2_TOKEN);

const MY_AGENT_ID = selectedToken === AGENT1_TOKEN ? AGENT1_ID : AGENT2_ID;
const OTHER_AGENT_ID = selectedToken === AGENT1_TOKEN ? AGENT2_ID : AGENT1_ID;

global.MY_AGENT_ID = MY_AGENT_ID;
global.OTHER_AGENT_ID = OTHER_AGENT_ID;

// console.log('MY_AGENT_ID:', MY_AGENT_ID);
// console.log('OTHER_AGENT_ID:', OTHER_AGENT_ID);

const client = new DeliverooApi(
    'http://localhost:8080',
    selectedToken
)

let config = {};

client.onConfig(cfg => {
    
    config = {
        ...cfg,
        PARCEL_DECADING_INTERVAL: utils.parseDecayInterval(cfg.PARCEL_DECADING_INTERVAL)
        
    }

    // console.log(config);

});

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = {id: null, name: null, x: null, y: null, score: null};

/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, lastUpdate:number, lastSeen:number} > }
 */
const freeParcels = new Map();
/**
 * @type { Set<string> }
 */
const assignedToOtherAgentParcels = new Set();
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

const COMM_DELAY = config.MOVEMENT_DURATION; // ms
global.COMM_DELAY = COMM_DELAY;


export {deliveryCells, freeParcels, carriedParcels, otherAgents, me, config, generatingCells, OTHER_AGENT_ID}

// Declare myAgent globally to avoid scope issues
let myAgent;

setInterval(() => {
    // Prepare the data to send as plain objects
    // Clone otherAgents and add/update our own agent info
    const otherAgentsToSend = new Map(otherAgents);
    
    const isMoving = !Number.isInteger(me.x) || !Number.isInteger(me.y);
    const direction = utils.getAgentDirection(me);
    const occupiedCells = utils.getAgentOccupiedCells(me);
    
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
    const data = {
        sendingFreeParcels: Object.fromEntries(freeParcels),
        sendingOtherAgents: Object.fromEntries(otherAgentsToSend)
    };
    client.emitSay(OTHER_AGENT_ID, data);
}, 100);


client.onMsg(async (fromId, fromName, msg, reply) => {
    if (fromId !== OTHER_AGENT_ID) return; // Only process messages from the other agent

    // Defensive: handle both string and object
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

    // Handle both types of messages: deleteParcel and state sync
    if (data && data.type === 'deleteParcel' && data.parcelId) {
        freeParcels.delete(data.parcelId);
    } else if (data && (data.sendingFreeParcels || data.sendingOtherAgents)) {
        // Convert received objects back to Maps
        const receivedFreeParcels = new Map(Object.entries(data.sendingFreeParcels || {}));
        const receivedOtherAgents = new Map(Object.entries(data.sendingOtherAgents || {}));
        
        // Update freeParcels
        for (const [id, receivedParcel] of receivedFreeParcels) {
            const localParcel = freeParcels.get(id);
            if (!localParcel || (receivedParcel.lastSeen > (localParcel.lastSeen || 0))) {
                freeParcels.set(id, { ...localParcel, ...receivedParcel });
            }
        }

        // Update otherAgents (except self)
        for (const [id, receivedAgent] of receivedOtherAgents) {
            if (id === MY_AGENT_ID) continue; // Skip self
            // console.log('receivedOtherAgents', receivedOtherAgents);
            const localAgent = otherAgents.get(id);
            // Only update if received info is more recent
            if (!localAgent || (receivedAgent.lastUpdate > (localAgent.lastUpdate || 0))) {
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

    // Handle drop_intention? requests
    if (typeof msg === 'string' && msg.startsWith('drop_intention?')) {
        console.log('drop_intention?', msg);
        const payload = msg.replace('drop_intention?', '');
        const [parcelId, theirScoreStr] = payload.split('|');
        // console.log('parcelId', parcelId);
        // console.log(theirScoreStr, "theirScoreStr");
        const theirScore = parseFloat(theirScoreStr);
        const bestIntention = myAgent.intention_queue[0]?.predicate;
        if (!bestIntention) {
            console.log('bestIntention is undefined');
            reply({ answer: 'no' });
            return;
        }
        // if (!utils.stillValid(bestIntention)) {
        //     console.log('bestIntention is not valid');
        //     reply({ answer: 'no' });
        //     return;
        // }
        if (
            bestIntention &&
            bestIntention[0] === 'go_pick_up' &&
            bestIntention[3] === parcelId
        ) {
            const myScore = utils.getScore(bestIntention);
            console.log('myScore', myScore);
            console.log('theirScore', theirScore);
            // For now, reply 'no' if score >= 0, 'yes' if score < 0
            if (reply) {
                if (myScore >= theirScore) {
                    reply({ answer: 'yes' }); // keep intention
                } else {
                    reply({ answer: 'no' }); // drop intention
                    // myAgent.intention_queue.shift();
                    assignedToOtherAgentParcels.add(parcelId);
                    console.log('assignedToOtherAgentParcels', assignedToOtherAgentParcels);
                    console.log('freeParcels id', freeParcels);
                }
            }
        } else {
            console.log('bestIntention is not a go_pick_up');
            console.log(bestIntention);
            reply({ answer: 'no' });
        }
        return;
    }
});


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
    // console.log('me', me);

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


client.onParcelsSensing(async (pp) => {
    carriedParcels.clear();

    for (const [id, parcel] of freeParcels) {
        // Remove parcels that are assigned to the other agent
        if (assignedToOtherAgentParcels.has(id)) {
            freeParcels.delete(id);
        }
        else if (
            utils.manhattanDistance({ x: parcel.x, y: parcel.y }, me) < config.PARCELS_OBSERVATION_DISTANCE &&
            !pp.find(p => p.id === parcel.id)
        ) {
            freeParcels.delete(id);
            // Notify the other agent to delete this parcel
            client.emitSay(OTHER_AGENT_ID, { type: 'deleteParcel', parcelId: id });
        }
    }

    for (const p of pp) {
        if (p.carriedBy === me.id && !carriedParcels.has(p.id)) {
            freeParcels.delete(p.id);
            // Notify the other agent to delete this parcel
            client.emitSay(OTHER_AGENT_ID, { type: 'deleteParcel', parcelId: p.id });
            carriedParcels.set(p.id, { id: p.id, reward: p.reward, lastUpdate: Date.now() });
        } else if (p.carriedBy === null && !assignedToOtherAgentParcels.has(p.id)) {
            // Update or add parcel, and set lastSeen

            let existing = freeParcels.get(p.id);
            freeParcels.set(p.id, {
                ...(existing || {}),
                ...p,
                lastUpdate: Date.now(), // or keep your logic for lastUpdate
                lastSeen: Date.now(),
            });
        } else {
            // Notify the other agent to delete this parcel
            client.emitSay(OTHER_AGENT_ID, { type: 'deleteParcel', parcelId: p.id });
            freeParcels.delete(p.id);
        }
    }
});

// ###################################################################################################
// OPTIONS GENERATION AND FILTERING
// ###################################################################################################

// Master intention reviser system
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

function generateOptions () {
    const carriedTotal = utils.carriedValue();

    let best_option = null;
    let best_distance = Number.MAX_VALUE;
    let second_best_option = null;
    let second_best_distance = Number.MAX_VALUE;

    // Check delivery option if carrying valuable parcels
    if (carriedTotal != 0) {
        const bestDelivery = utils.findClosestDelivery(me.x, me.y);
        if (bestDelivery && bestDelivery.path) {
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
        if (
            Number.isInteger(me.x) && Number.isInteger(me.y) &&
            Number.isInteger(parcel.x) && Number.isInteger(parcel.y) &&
            !assignedToOtherAgentParcels.has(parcel.id)
        ) {
            const pickupPath = utils.getShortestPath(me.x, me.y, parcel.x, parcel.y);
            if (pickupPath && pickupPath.cost < best_distance) {
                second_best_distance = best_distance;
                second_best_option = best_option;
                best_distance = pickupPath.cost;
                best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, pickupPath.path];
            } else if (pickupPath && pickupPath.cost < second_best_distance) {
                second_best_distance = pickupPath.cost;
                second_best_option = ['go_pick_up', parcel.x, parcel.y, parcel.id, pickupPath.path];
            }
        }
    }
    

    
    // Push the best option found
    if (best_option !== null && best_distance !== null) {
        myAgent.push(best_option);
    } else {
        myAgent.push(['idle']);
    }

}


client.onParcelsSensing( generateOptions )
client.onAgentsSensing( generateOptions )
client.onYou( generateOptions )


// ###################################################################################################
// INTENTION REVISION
// ###################################################################################################


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
                // console.log('Intention queue', this.intention_queue);
            
                // Current intention
                const intention = this.intention_queue[0];
                if (intention.predicate[0] == 'idle') {
                    await intention.achieve()
                    .catch( error => {
                    } );
                    this.intention_queue.shift();
                    continue;
                }
                
                // Is queued intention still valid? Do I still want to achieve it?
                // TODO this hard-coded implementation is an example
                let id = intention.predicate[3]
                // console.log(id, "id");
                let p = freeParcels.get(id)
                if ( !utils.stillValid(intention.predicate) ) {
                    this.intention_queue.shift();
                    continue;
                }
                
                if (intention.predicate[0] == 'go_pick_up') {
                    if (otherAgents.has(OTHER_AGENT_ID) && MY_AGENT_ID !== AGENT1_ID) {
                        let reply = await client.emitAsk(OTHER_AGENT_ID, `drop_intention?${id}|${utils.getScore(intention.predicate)}`);
                        if (reply && reply['answer'] === 'yes') {
                            console.log('dropping intention cause said yesssss', intention.predicate[0]);
                            this.intention_queue.shift();
                            assignedToOtherAgentParcels.add(id);
                            console.log('assignedToOtherAgentParcels', assignedToOtherAgentParcels);
                            console.log('freeParcels id', freeParcels);

                            // let newbestintention = this.intention_queue[0];
                            // // console.log('newbestintention', newbestintention.predicate);
                            // generateOptions();
                            // newbestintention = this.intention_queue[0];
                            // console.log('newbestintention2', newbestintention.predicate);
                            continue;
                        }
                    }
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

    // log ( ...args ) {
    //     console.log( ...args )
    // }

    async push(predicate) {

        if(!Number.isInteger(me.x) || !Number.isInteger(me.y)) return;

        // Find existing index with same id (only for go_pick_up)
        // Check if already queued
        const last = this.intention_queue[this.intention_queue.length - 1];
        // console.log('Last intention', last);
        // console.log('Predicate', predicate);
        
        if ( last && last.predicate.slice(0, 3).join(' ') == predicate.slice(0, 3).join(' ') ) {
            return; // intention is already being achieved
        }
        // console.log('Predicate after achieved removed', predicate);    
        // Check if there is already an intention with the same first 4 elements
        if (this.intention_queue.some(i =>
            i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ')
        )) {
            return;
        }
        // console.log('Predicate after  same 4 achieved removed', predicate);    

        // This is a reference to the actual object in the queue, not a copy
        let existingIntention = this.intention_queue.find(i => {
            return i.predicate.slice(0, 4).join(' ') === predicate.slice(0, 4).join(' ');
        });
        // console.log('Existing intention', existingIntention);
        if (existingIntention && existingIntention.predicate[0] != "idle")
            existingIntention.updateIntention(predicate);
        // console.log('Existing intention after update', existingIntention);
        const intention = new Intention( this, predicate );
        // console.log('Intention', intention.predicate);
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
            case "go_deliver_agent":
                this.predicate[3] = predicate[3]; // path
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
        // if ( this.stopped ) throw ['stopped']; // if stopped then quit
        return true;
    }

}

class GoDeliver extends Plan {

    static isApplicableTo ( go_deliver, x, y, path ) {
        return go_deliver == 'go_deliver';
    }

    async execute ( go_deliver, x, y, path ) {
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await this.subIntention( ['go_to', x, y, path] );
        if ( this.stopped ) throw ['stopped']; // if stopped then quit
        await client.emitPutdown()
        // if ( this.stopped ) throw ['stopped']; // if stopped then quit
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

class GoDeliverAgent extends Plan {
    static isApplicableTo(go_deliver_agent, x, y, path) {
        return go_deliver_agent == 'go_deliver_agent';
    }

    async execute(go_deliver_agent, x, y, path) {
        // console.log('Go deliver agent');
        if (this.stopped) throw ['stopped']; // if stopped then quit
        await this.subIntention(['go_to', x, y, path]);
        if (this.stopped) throw ['stopped']; // if stopped then quit
        
        
        // Check distance to OTHER_AGENT_ID
        const other = otherAgents.get(OTHER_AGENT_ID);
        if (other && other.x !== undefined && other.y !== undefined) {
            const dist = utils.manhattanDistance(me, other);
            if (dist <= 4) {
                // console.log('Putdown parcels near other agent');
                // Always putdown parcels first
                const parcelsToPick = Array.from(carriedParcels.keys());
                console.log('assigned parcels before putdown', assignedToOtherAgentParcels);
                console.log('Parcels to pick', parcelsToPick);
                for (const parcelId of parcelsToPick) {
                    let parcel = freeParcels.get(parcelId);
                    if (parcel) {
                        freeParcels.delete(parcelId);
                    }
                    assignedToOtherAgentParcels.add(parcelId);
                }
                await client.emitPutdown();
                if (this.stopped) throw ['stopped']; // if stopped then quit
                console.log('assigned parcels after putdown', assignedToOtherAgentParcels);
                
                // Assign these parcels to the other agent

                
                // Send message to other agent to pick up these parcels
                
                // Move away from the drop location (try to move to a neighboring free cell)
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

                    


                                    // Wait a bit for parcels to appear in freeParcels
                // await new Promise(resolve => setTimeout(resolve, 200));
                }

                return true;
            }
        }
        
        // If not within distance, parcels are already putdown but not assigned to other agent
        // console.log('Putdown parcels but not near other agent');
        return true;
    }
}

// plan classes are added to plan library 
planLibrary.push( GoPickUp )
planLibrary.push( GoDeliver )
planLibrary.push( BlindMove )
planLibrary.push( IdleMove )
planLibrary.push( GoDeliverAgent )

// Initialize the agent after all classes are defined
myAgent = new IntentionRevision();
myAgent.loop();