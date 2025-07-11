TODO:
Single Agent: (OPTIONAL)
- fix the problem with colliding with other agents and getting penalty ( sometimes it happens (we need to know why its only sometimes))
- fix the problem with that if every other path is blocked then it doesn't move at all 
- Modify the score function for the intention (DONE)
- EXPLORE : 
    - for choosing the candidates: 
        1- number of generating cells (or the ratio)
        2- number of cells 
        3- distance to the best delivery point (or top 3 delivery points)
        4- distance to other chosen candidates 
    - for scoring the candidates: 
        1- top 3 criteria for choosing the candidates (which is the main score) 
        2- path cost to the candidate
        3- lastUpdate of the candidate 
        4- number of agents seen near the candidate



Multi Agent: (MANDATORY)
- Communication between agents :
    1- Exchange information about the environment
    2- Exchange information about their mental states to coordinate their activities
- Explicit a game strategy and coordination mechanisms
    - Should figure it out later 
-       (suggestions: 
        1- EXPLORE better (split the map / choose the candidates accordingly)
        2- NO PATH for one Agent (so the other agent should take the parcels and deliver)
        3- 
        4-   
        5- 
        6- )


PLANNING: (MANDATORY)
- Decide to add it to Single Agent or Multi Agent
- Where to add it and how to use it 
- the implementation of the planning 














CONCERNS: 
SINGLE AND MULTI AGENT: 
1- no way parcels

Multi: 
1- assignedtootheragent memory size 