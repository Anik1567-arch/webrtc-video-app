from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import json
from typing import Dict, List

app = FastAPI()

# Mount the static folder to serve CSS and JS files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Dictionary to store active rooms and their connected WebSocket clients
# Format: {"room_id": [websocket1, websocket2]}
rooms: Dict[str, List[WebSocket]] = {}

@app.get("/")
async def serve_home():
    """Serve the main HTML application."""
    return FileResponse("static/index.html")

@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()

    if room_id not in rooms:
        rooms[room_id] = []

    # Restrict room to 2 participants for 1-on-1 calling
    if len(rooms[room_id]) >= 2:
        await websocket.send_text(json.dumps({"type": "full"}))
        await websocket.close()
        return

    rooms[room_id].append(websocket)
    num_clients = len(rooms[room_id])

    # If this is the 2nd person joining, notify the 1st person that their peer is ready
    if num_clients == 2:
        first_peer = rooms[room_id][0]
        await first_peer.send_text(json.dumps({"type": "ready"}))

    try:
        while True:
            # Receive signaling data (Offer, Answer, ICE Candidates, or Leave)
            data = await websocket.receive_text()
            
            # Relay the message to the OTHER participant in the room
            for client in rooms[room_id]:
                if client != websocket:
                    await client.send_text(data)

    except WebSocketDisconnect:
        # Clean up when a user closes their tab or clicks "End Call"
        if room_id in rooms and websocket in rooms[room_id]:
            rooms[room_id].remove(websocket)
            
            # Notify the remaining user that their friend disconnected
            for client in rooms[room_id]:
                await client.send_text(json.dumps({"type": "peer-left"}))
            
            # Delete the room if it's completely empty
            if len(rooms[room_id]) == 0:
                del rooms[room_id]