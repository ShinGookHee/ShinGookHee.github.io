# IE416 응답 수집 서버

다중 로봇 감독 실험의 참가 화면, 연구자 관리 및 팀원용 결과 조회를 한 Python 서버에서 제공한다.

| 경로 | 용도 |
| --- | --- |
| `/` | 개인 링크로 참가하는 실험 화면 |
| `/admin` | 관리자 로그인, 참가 링크 발급, 진행 현황 및 CSV·JSON 다운로드 |
| `/results` | 팀원 로그인, UI 조건·실험 유형·프로토콜 버전별 집계 |
| `/healthz` | 호스팅 상태 확인 |

## 시작

Python 3.9 이상에서 다음 명령을 실행한다. 비공개 SA 문항집을 먼저 서버에 전달하고 `IE416_SA_BANK_PATH`에 그 파일의 절대 경로를 설정한다.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-collection.txt
.venv/bin/python study_collection.py
```

로컬 확인 주소는 `http://127.0.0.1:8767/results`이다. 로컬 계정 기본값은 관리자 `admin / 1111`, 팀원 `viewer / 2222`이다.

## 외부 접속

GitHub Pages는 공개 체험 데모를 제공한다. 이 브랜치의 Python 수집 서버는 지속 저장 공간이 연결된 별도 HTTPS 환경에서 실행한다. 환경 변수에 아래 값을 지정한다.

| 이름 | 값 |
| --- | --- |
| `IE416_PUBLIC_URL` | 참가 링크에 사용할 HTTPS 오리진 |
| `IE416_DATA_DIR` | 응답을 보관할 지속 저장 볼륨 내 절대 경로 |
| `IE416_SA_BANK_PATH` | 비공개 `sa_bank_v2.json`의 절대 경로 |
| `IE416_ADMIN_PASSWORD` | 관리자 비밀번호, 16자 이상 |
| `IE416_VIEWER_PASSWORD` | 팀원용 비밀번호, 관리자와 다른 16자 이상 값 |

HTTPS 프록시를 같은 호스트에 두면 기본 바인딩 `127.0.0.1:8767`을 사용한다. 호스팅 플랫폼이 내부 포트에 연결하면 `python study_collection.py --host 0.0.0.0`으로 실행하고 플랫폼의 `PORT` 설정을 사용한다. 동일한 저장 경로를 단일 프로세스에서 사용한다. 팀원에게 HTTPS 결과 주소와 팀원용 자격 증명을 제공한다.

응답 파일, 비공개 문항집, 배포 자격 증명은 별도로 관리한다. 참가자는 승인된 별도 연구 안내와 동의 절차를 거친다.

## 검증

```sh
.venv/bin/python -m unittest discover -s tests -p 'test_study*.py' -v
```
