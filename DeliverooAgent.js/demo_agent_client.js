import { default as config } from "./config.js";
import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)
// client.onConnect( () => console.log( "socket", client.socket.id ) );
// client.onDisconnect( () => console.log( "disconnected", client.socket.id ) );

const me = {id: null, name: null, x: null, y: null, score: null};
client.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score
} )

const beliefset = new Map();

async function agentLoop () {

    var previous = 'right'

    while ( true ) {

        await client.emitPutdown();

        await client.emitPickup();

        let tried = [];

        while ( tried.length < 4 ) {
            
            let current = { up: 'down', right: 'left', down: 'up', left: 'right' }[previous] // backward

            if ( tried.length < 3 ) { // try haed or turn (before going backward)
                current = [ 'up', 'right', 'down', 'left' ].filter( d => d != current )[ Math.floor(Math.random()*3) ];
            }
            
            if ( ! tried.includes(current) ) {
                
                if ( await client.emitMove( current ) ) {
                    // console.log( 'moved', current );
                    previous = current;
                    break; // moved, continue
                }
                
                tried.push( current );
                
            }
            
        }

        if ( tried.length == 4 ) {
            console.log( 'stucked' );
            await new Promise(res=>setTimeout(res,1000)); // stucked, wait 1 sec and retry
        }


    }
}

// client.onAgentsSensing( (agents) => {

//     for (let a of agents) {
//         beliefset.set(a.id, a);
//     }

//     let print = Array
//     .from(beliefset.values())
//     .map( ({name, x, y}) => {
//         return `${name}:${x},${y}`;
//     }).join(' ');

//     console.log(print);
// })

client.onParcelsSensing( async (parcels) => {

    for ( let p of parcels ) {
        if ( ! p.carriedBy ) {
            if      ( me.x < p.x && me.y == p.y )
                await client.emitMove('right');
            else if ( me.x > p.x && me.y == p.y )
                await client.emitMove('left')
            else if ( me.y < p.y && me.x == p.x )
                await client.emitMove('up')
            else if ( me.y > p.y && me.x == p.x )
                await client.emitMove('down')

            if ( me.x == p.x && me.y == p.y ) {
                await client.emitPickup();
            }
        }
    }
})

// agentLoop()