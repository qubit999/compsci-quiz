const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Load all question files
const questionsPath = path.join(__dirname, 'questions');
const topics = {};

// Shuffle array function
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Check if file is multiple choice
function isMultipleChoice(filename) {
    return filename.endsWith('_mquestions.json');
}

// Read all question files
fs.readdirSync(questionsPath).forEach(file => {
    if (file.endsWith('_questions.json') || file.endsWith('_mquestions.json')) {
        const topicName = file.replace('_questions.json', '').replace('_mquestions.json', '');
        const topicDisplayName = topicName.charAt(0).toUpperCase() + topicName.slice(1).replace(/_/g, ' ');
        topics[topicName] = {
            displayName: topicDisplayName,
            questions: JSON.parse(fs.readFileSync(path.join(questionsPath, file), 'utf8')),
            isMultipleChoice: isMultipleChoice(file)
        };
    }
});

// Get available topics
app.get('/topics', (req, res) => {
    const topicList = Object.keys(topics).map(key => ({
        id: key,
        name: topics[key].displayName,
        questionCount: topics[key].questions.length,
        isMultipleChoice: topics[key].isMultipleChoice
    }));
    res.json(topicList);
});

// Store active games
const games = new Map();

// Generate game invite link
app.post('/create-game', express.json(), (req, res) => {
    const { topic } = req.body;
    
    if (!topics[topic]) {
        return res.status(400).json({ error: 'Invalid topic' });
    }
    
    // Create a deep copy of questions and shuffle them
    const gameQuestions = JSON.parse(JSON.stringify(topics[topic].questions));
    const shuffledQuestions = shuffleArray(gameQuestions);
    
    // Shuffle the options for each question
    shuffledQuestions.forEach(question => {
        // Store the correct answer(s) before shuffling
        const correctAnswers = Array.isArray(question.correct) ? question.correct : [question.correct];
        // Shuffle the options
        question.options = shuffleArray(question.options);
        // Make sure the correct answer reference is still valid
        question.correct = correctAnswers;
    });
    
    const gameId = uuidv4();
    games.set(gameId, {
        id: gameId,
        topic: topic,
        questions: shuffledQuestions,
        players: new Map(),
        currentQuestion: 0,
        answers: new Map(),
        started: false,
        scores: new Map(),
        isMultipleChoice: topics[topic].isMultipleChoice
    });
    
    res.json({ 
        gameId, 
        inviteLink: `${req.protocol}://${req.get('host')}/game.html?id=${gameId}`,
        topicName: topics[topic].displayName
    });
});

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// WebSocket server with heartbeat
const wss = new WebSocket.Server({ 
    server,
    clientTracking: true,
    perMessageDeflate: false
});

// Heartbeat interval
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Function to send heartbeat
function heartbeat() {
    this.isAlive = true;
}

// Check all connections every 30 seconds
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
    clearInterval(interval);
});

wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const gameId = urlParams.get('gameId');
    let playerId = urlParams.get('playerId') || uuidv4();
    
    // Setup heartbeat
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const game = games.get(gameId);

            // Handle ping from client
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            if (!game) {
                ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
                return;
            }

            switch (data.type) {
                case 'join':
                    handleJoin(game, playerId, data.name, ws);
                    break;
                case 'rejoin':
                    handleRejoin(game, data.playerId, data.name, ws);
                    playerId = data.playerId;
                    break;
                case 'start':
                    handleStart(game);
                    break;
                case 'answer':
                    handleAnswer(game, playerId, data.answer);
                    break;
                case 'disconnect':
                    handleDisconnect(game, playerId);
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
    });

    ws.on('close', () => {
        const game = games.get(gameId);
        if (game && playerId) {
            // Mark player as disconnected but don't remove them immediately
            const player = game.players.get(playerId);
            if (player) {
                player.connected = false;
                broadcastToGame(game, {
                    type: 'playerDisconnected',
                    playerId,
                    playerName: player.name
                });
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function handleJoin(game, playerId, playerName, ws) {
    game.players.set(playerId, { 
        id: playerId, 
        name: playerName, 
        ws,
        connected: true 
    });
    game.scores.set(playerId, 0);
    
    // Send game state to new player
    ws.send(JSON.stringify({
        type: 'joined',
        playerId,
        players: Array.from(game.players.values()).map(p => ({ 
            id: p.id, 
            name: p.name,
            connected: p.connected 
        })),
        started: game.started,
        topic: topics[game.topic].displayName,
        currentQuestion: game.currentQuestion,
        totalQuestions: game.questions.length,
        isMultipleChoice: game.isMultipleChoice
    }));

    // If game is in progress, send current question
    if (game.started && game.currentQuestion < game.questions.length) {
        const question = game.questions[game.currentQuestion];
        ws.send(JSON.stringify({
            type: 'question',
            questionNumber: game.currentQuestion + 1,
            totalQuestions: game.questions.length,
            question: question.question,
            options: question.options,
            isMultipleChoice: game.isMultipleChoice
        }));
    }

    // Notify all players
    broadcastToGame(game, {
        type: 'playerJoined',
        player: { id: playerId, name: playerName, connected: true },
        players: Array.from(game.players.values()).map(p => ({ 
            id: p.id, 
            name: p.name,
            connected: p.connected 
        }))
    });
}

function handleRejoin(game, playerId, playerName, ws) {
    const existingPlayer = game.players.get(playerId);
    if (existingPlayer) {
        existingPlayer.ws = ws;
        existingPlayer.connected = true;
        
        // Send current game state
        ws.send(JSON.stringify({
            type: 'rejoined',
            playerId,
            players: Array.from(game.players.values()).map(p => ({ 
                id: p.id, 
                name: p.name,
                connected: p.connected 
            })),
            started: game.started,
            topic: topics[game.topic].displayName,
            currentQuestion: game.currentQuestion,
            isMultipleChoice: game.isMultipleChoice,
            scores: Array.from(game.scores.entries()).map(([id, score]) => ({
                playerId: id,
                playerName: game.players.get(id).name,
                score
            }))
        }));

        // If game is in progress, send current question
        if (game.started && game.currentQuestion < game.questions.length) {
            const question = game.questions[game.currentQuestion];
            ws.send(JSON.stringify({
                type: 'question',
                questionNumber: game.currentQuestion + 1,
                totalQuestions: game.questions.length,
                question: question.question,
                options: question.options,
                isMultipleChoice: game.isMultipleChoice,
                alreadyAnswered: game.answers.has(game.currentQuestion) && 
                                game.answers.get(game.currentQuestion).has(playerId)
            }));
        }

        // Notify all players
        broadcastToGame(game, {
            type: 'playerReconnected',
            playerId,
            playerName,
            players: Array.from(game.players.values()).map(p => ({ 
                id: p.id, 
                name: p.name,
                connected: p.connected 
            }))
        });
    } else {
        // If player doesn't exist, treat as new join
        handleJoin(game, playerId, playerName, ws);
    }
}

function handleStart(game) {
    game.started = true;
    sendQuestion(game);
}

function handleAnswer(game, playerId, answer) {
    if (!game.answers.has(game.currentQuestion)) {
        game.answers.set(game.currentQuestion, new Map());
    }
    
    const questionAnswers = game.answers.get(game.currentQuestion);
    
    // Prevent duplicate answers
    if (questionAnswers.has(playerId)) {
        return;
    }
    
    questionAnswers.set(playerId, answer);

    // Check if answer is correct
    const currentQuestion = game.questions[game.currentQuestion];
    let isCorrect = false;
    
    if (game.isMultipleChoice) {
        // For multiple choice, check if selected answers match correct answers exactly
        const selectedAnswers = Array.isArray(answer) ? answer.sort() : [answer];
        const correctAnswers = currentQuestion.correct.sort();
        isCorrect = JSON.stringify(selectedAnswers) === JSON.stringify(correctAnswers);
    } else {
        // For single choice
        isCorrect = answer === currentQuestion.correct[0];
    }
    
    if (isCorrect) {
        game.scores.set(playerId, game.scores.get(playerId) + 1);
    }

    // Send answer feedback to player
    const player = game.players.get(playerId);
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify({
            type: 'answerFeedback',
            correct: isCorrect,
            selectedAnswer: answer,
            correctAnswer: currentQuestion.correct,
            isMultipleChoice: game.isMultipleChoice
        }));
    }

    // Count only connected players
    const connectedPlayers = Array.from(game.players.values()).filter(p => p.connected);
    
    // Check if all connected players have answered
    if (questionAnswers.size >= connectedPlayers.length) {
        // Send feedback to all players about correct answer
        broadcastToGame(game, {
            type: 'showCorrectAnswer',
            correctAnswer: currentQuestion.correct
        });

        // Wait 3 seconds before showing results
        setTimeout(() => {
            // Show results
            broadcastToGame(game, {
                type: 'questionResults',
                correct: currentQuestion.correct,
                scores: Array.from(game.scores.entries()).map(([id, score]) => ({
                    playerId: id,
                    playerName: game.players.get(id).name,
                    score
                }))
            });

            // Move to next question after another delay
            setTimeout(() => {
                game.currentQuestion++;
                game.answers.delete(game.currentQuestion - 1);

                if (game.currentQuestion < game.questions.length) {
                    sendQuestion(game);
                } else {
                    endGame(game);
                }
            }, 3000);
        }, 3000);
    }
}

function sendQuestion(game) {
    const question = game.questions[game.currentQuestion];
    broadcastToGame(game, {
        type: 'question',
        questionNumber: game.currentQuestion + 1,
        totalQuestions: game.questions.length,
        question: question.question,
        options: question.options,
        isMultipleChoice: game.isMultipleChoice
    });
}

function endGame(game) {
    const finalScores = Array.from(game.scores.entries())
        .map(([id, score]) => ({
            playerId: id,
            playerName: game.players.get(id).name,
            score
        }))
        .sort((a, b) => b.score - a.score);

    broadcastToGame(game, {
        type: 'gameEnd',
        scores: finalScores
    });

    // Clean up game after 5 minutes
    setTimeout(() => {
        games.delete(game.id);
    }, 300000);
}

function handleDisconnect(game, playerId) {
    game.players.delete(playerId);
    game.scores.delete(playerId);
    
    broadcastToGame(game, {
        type: 'playerLeft',
        playerId,
        players: Array.from(game.players.values()).map(p => ({ 
            id: p.id, 
            name: p.name,
            connected: p.connected 
        }))
    });

    // If no players left, delete the game
    if (game.players.size === 0) {
        games.delete(game.id);
    }
}

function broadcastToGame(game, message) {
    game.players.forEach(player => {
        if (player.ws && player.ws.readyState === WebSocket.OPEN) {
            try {
                player.ws.send(JSON.stringify(message));
            } catch (error) {
                console.error('Error broadcasting to player:', player.id, error);
            }
        }
    });
}