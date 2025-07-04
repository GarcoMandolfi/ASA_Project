import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    // 'https://deliveroojs25.azurewebsites.net',
    'http://localhost:8080',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjNiZGJmMSIsIm5hbWUiOiJUd29CYW5hbmFzIiwicm9sZSI6InVzZXIiLCJpYXQiOjE3NTEzNjA2NDF9.J5uTBh3yTrUviXsl0o8djdHoMQ03tS0CE0lnJUDdKCE'
)

const beliefset = new Map();

client.onConfig( config => {
    console.log('Config:', config);
    console.log('Agents observation distance:', config.AGENTS_OBSERVATION_DISTANCE);
})
client.onMap( (x,y,tiles) => {
    console.log('Map:', x,y,tiles);
} )

client.onYou( me => {
    // console.log('You:', me);
})
client.onAgentsSensing( ( agents ) => {

    for ( let a of agents ) {
        beliefset.set( a.id, a );
    }

    let prettyPrint = Array
    .from(beliefset.values())
    .map( ({name,x,y,score}) => {
        return `${name}(${score}):${x},${y}`;
    } ).join(' ');
    console.log(prettyPrint)

} )

