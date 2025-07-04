import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

function distance( {x:x1, y:y1}, {x:x2, y:y2}) {
    const dx = Math.abs( Math.round(x1) - Math.round(x2) )
    const dy = Math.abs( Math.round(y1) - Math.round(y2) )
    return dx + dy;
}

const me = {};

client.onYou( ( {id, name, x, y, score} ) => {
    me.id = id
    me.name = name
    me.x = x
    me.y = y
    me.score = score
} )

var control = false;

client.onParcelsSensing( async ( parcels ) => {

    console.log( `me(${me.x},${me.y})`,
        control ? 'skip' : 'go to parcels: ',
        parcels
        .map( p => `${p.reward}@(${p.x},${p.y})` )
        .join( ' ' )
    );

    if ( control ) {
        return;
    }
    control = true;
    
    for ( let p of parcels ) {
        if ( ! p.carriedBy ) {
            if      ( me.x == p.x-1 && me.y == p.y )
                await client.emitMove('right');
            else if ( me.x == p.x+1 && me.y == p.y )
                await client.emitMove('left')
            else if ( me.y == p.y-1 && me.x == p.x )
                await client.emitMove('up')
            else if ( me.y == p.y+1 && me.x == p.x )
                await client.emitMove('down')

            if ( me.x == p.x && me.y == p.y ) {
                await client.emitPickup();
            }
        }
    }
    
    control = false;

} )


