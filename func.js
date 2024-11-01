import {bot} from "./tendermintBot.js";
import axios from "axios";
import * as text from "./textConstant.js";
import {CountDto, ValidatorInfo} from "./dtos.js";
import dotenv from 'dotenv';
import * as DB from "./connectionPool.js"
import {logger} from "./log.js";


dotenv.config();
var authenticationDict = {};

export async function onOpen(chatId, ip, validatorNode) {
    sendMessage(chatId, ip + " 연결이 성공적으로 이루어졌습니다.");

    logger.info(`${ip} Websocket connected`)

    await validatorNode.setValidatorInfo(await getValiInfo(ip));

    subscribeToEvent(validatorNode.WebSocket, "NewBlock", 1);
    subscribeToEvent(validatorNode.WebSocket, "Vote",2);
    subscribeToEvent(validatorNode.WebSocket, "NewRound",3);
}

export function onDelete(username, ip, validatorNode) {
    validatorNode.delete();
    const message = `${username}에 의해 ${ip}연결을 종료합니다.`;
    logger.info(message);
    sendMessageAllChat(message);
}

export function onStart(chatId, username, input) {
    const password = process.env.password;

    if(authenticationDict[chatId]) {
        sendMessage(chatId, "이미 인증된 사용자입니다.");
        return;
    }

    authenticationDict[chatId] = input === password;

    if(authenticationDict[chatId]) {
        logger.info(`${username} 연결 성공`)
    }
    else {
        logger.warn(`${username} 열결 실패`)
    }

    sendMessage(chatId, text.Authentication(chatId, authenticationDict[chatId]));
}

export async function onNewBlock(chatId, ip, chainId, height, signatures, myAddress, voteDict) {

    if(voteDict[chainId] == null)
        return;

    const findoutMyVali = signatures.find(element => {
        if (element.validator_address === myAddress)
            return element;
    });

    if (findoutMyVali == null || (findoutMyVali.block_id_flag !== 2 && findoutMyVali.block_id_flag !== 3)) {
        const block = await getBlockData(ip, height);
        await DB.insertMissblockData(chainId, height, changeTime(block.created), block.proposer);
        const addressList = await getValidatorList(ip, height);

        let message = `*[Miss Block Detected]*\n` + text.MissBlock(chainId, height, myAddress, addressList[myAddress], block.proposer);

        const copy = Object.assign([], voteDict[chainId][height]);

        if(!(copy == null || !copy.length))
            onVote(copy);

        logger.warn(`${chainId} - ${height} Miss Block Detected`);

        sendMessageAllChat(message)
    }

    delete voteDict[chainId][height];
}

export async function onVote(voteDtoList) {
    await DB.insertVoteData(voteDtoList);
}

export async function onSelect(chatId, networkDict, start, end) {
    const results = await DB.selectMissblockData(start, end);

    if(results == null) {
        logger.error("Missblock 조회 실패")
        sendMessage(chatId, "조회에 실패하였습니다.");
        return;
    }

    let output = `*${DB.filterDate(start)}`;
    output += end == null ? "" : ` ~ ${DB.filterDate(end)}`
    output += `*\n`

    output += `-- VI는 조회가 되지않은 Validator 입니다.\n`

    var resultDict = {}
    var validatorIndexDict = {};

    for (const network in networkDict) {
        const ip = networkDict[network];

        validatorIndexDict[network] = await getValidatorList(ip);
    }

    results.forEach(row => {
        if(networkDict[row.chain] == null)
            return;

        if(resultDict[row.chain] == null)
            resultDict[row.chain] = [];

        resultDict[row.chain].push(new CountDto(row.chain, row.proposer, validatorIndexDict[row.chain][row.proposer], row.count));
    })

    Object.keys(resultDict).forEach(key => {
        output += `*[${key}]*\n`
        resultDict[key].forEach(dto => {
            const index = dto.index == null ? "--" : dto.index;

            output += `${index} VI : ${dto.count} 개\n`
        })

        output += "\n";
    })

    sendMessage(chatId, output);
}

export async function onSelectVote(chatId, height, network) {
    const results = await DB.selectVote(height, network);

    if(results == null) {
        logger.error("Vote 조회 실패")
        sendMessage(chatId, "조회에 실패하였습니다.");
        return;
    }

    var strVote = ["", ""];

    strVote[0] = "*[PreVote]*\n";
    strVote[1] = "*[PreCommit]*\n";

    results.forEach((row) => {
        const type = row.type === 2 ? "PreCommit" : "PreVote";
        const arrayIndex = row.type - 1;
        strVote[arrayIndex] += `${row.index + 1} - ${type}\n`;
    });

    const message = `*[${height}]*\n` +
        `${strVote[0]}\n${strVote[1]}`;

    sendMessage(chatId, message);
}

export function onShow(chatId, validatorNodeDict) {
    var IPs = "";

    const ipList = Object.keys(validatorNodeDict);

    ipList.forEach(ip => {
        IPs += text.Show(ip, validatorNodeDict[ip].ValidatorInfo.validatorAddr);
    });

    if (IPs === "")
        IPs = "등록된 Node가 없습니다.";

    sendMessage(chatId, `*[Node Info]*\n${IPs}`, {"parse_mode" : "Markdown"});
}

export async function onStatus(chatId, ipList) {
    var message = "";

    for (const ip of ipList) {
        const result = await getStatus(ip);
        message += result + "\n";
    }

    sendMessage(chatId, "*[Status]*\n" + message)
}

export function onHelp(chatId) {
    var message = text.notAuthHelp;

    if(authenticationDict[chatId])
        message += text.Help

    sendMessage(chatId, message)
}

export function onVersion(chatId) {
    sendMessage(chatId, text.version);
}


export function onError(error, ip) {
    const message = `${ip} 연결 에러 발생`;
    logger.error(error);
    sendMessageAllChat(message);
}

export function onClose(ip) {
    const message = `${ip} 연결이 종료되었습니다.`;
    logger.info(message);
    sendMessageAllChat(message);
}



export async function getStatus(ip) {
    const response = await axios.get(`http://${ip}:26657/status`);
    const result = response.data.result;

    const id = result.node_info.id;
    const network = result.node_info.network;
    const version = result.node_info.version;
    const moniker = result.node_info.moniker;
    const height = result.sync_info.latest_block_height;
    const valiAddr = result.validator_info.address;
    const votingPwr = result.validator_info.voting_power;

    const validatorDict = await getValidatorList(ip);

    const valiIndex = validatorDict[valiAddr];

   return text.Status(id, network, version, moniker, height, valiAddr, valiIndex, votingPwr);
}

export async function getBlockData(ip, height) {
    const response = await axios.get(`http://${ip}:26657/block?height=${height}`);

    return {
        proposer : response.data.result.block.header.proposer_address,
        created : response.data.result.block.header.time
    };
}

export function sendMessage(chatId, string) {
    if(chatId != null)
        bot.sendMessage(chatId, messageFilter(string), {"parse_mode" : "Markdown"});
}

export async function getValiInfo(ip) {
    const response = await axios.get(`http://${ip}:26657/status`);
    const result = response.data.result;

    const id = result.node_info.id;
    const network = result.node_info.network;
    const moniker = result.node_info.moniker;
    const valiAddr = result.validator_info.address;

    return new ValidatorInfo(id, moniker, network, valiAddr);
}

export async function getValidatorList(ip, height = null) {

    let url = `http://${ip}:26657/validators?per_page=200`;

    if(height != null)
        url += `&height=${height}`;

    const response = await axios.get(url);

    const validators = response.data.result.validators;
    var output = {};

    validators.forEach((validator, index) => {
        output[validator.address] = index + 1;
    })


    return output;
}

export function getAuthentication(chatId) {
    return authenticationDict[chatId];
}
export function sendErrorMsg(chatId) {
    sendMessage(chatId, "Bot Error 발생 Log 확인");
}

export function sendMessageAllChat(message) {
    Object.keys(authenticationDict).forEach(chatId => {
        if(authenticationDict[chatId])
            sendMessage(chatId, message)
    });
}

function changeTime(utcTime) {
    const date = new Date(utcTime);

    return new Date(date.toLocaleString('en-US', {timeZone: 'Asia/Seoul'}));
}

function messageFilter(str) {
    return str.replaceAll("_", "-");
}

function subscribeToEvent(ws, eventType, id) {
    const request = {
        "jsonrpc": "2.0",
        "method": "subscribe",
        "params": {
            "query": `tm.event = '${eventType}'`
        },
        "id": id // 랜덤 ID 생성
    };

    ws.send(JSON.stringify(request));
}