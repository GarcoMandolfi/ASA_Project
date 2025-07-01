import { DeliverooApi } from "@unitn-asa/deliveroo-js-client";

const client = new DeliverooApi(
    'http://localhost:8080',
    'GET YOUR OWN API KEY'
)

var me;
client.onYou( m => {
    me = m;
});

client.onMap( (width, height, tiles) => {
    console.log('Map of width ' + width + ' and height ' + height);
})

