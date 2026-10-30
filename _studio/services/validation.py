"""路由输入校验：请求形状、必填字段与持久化快照结构。"""

import datetime
import re


def object_body(body):
    if not isinstance(body, dict):
        raise ValueError('Body must be an object')


def fields(**schema):
    def validate(body):
        object_body(body)
        for name, expected in schema.items():
            value = body.get(name)
            if not isinstance(value, expected) or (expected is str and not value.strip()):
                raise ValueError(f'Invalid or missing {name}')
            if expected is int and (isinstance(value, bool) or value < 0):
                raise ValueError(f'Invalid {name}')
    return validate


def strings(value):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError('Expected an array of strings')


def records(value):
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError('Expected an array of objects')


def cards(value):
    records(value)
    for item in value:
        if '_enc' in item:
            fields(_enc=str)(item)
        else:
            fields(title=str, url=str)(item)
            for key in ('id', 'icon', 'style', 'description', 'bgText'):
                if key in item and not isinstance(item[key], str):
                    raise ValueError(f'Invalid card {key}')


def changelog(value):
    records(value)
    for item in value:
        fields(date=str, entries=list)(item)
        datetime.date.fromisoformat(item['date'])
        strings(item['entries'])


def categories(value):
    records(value)
    for item in value:
        fields(name=str, tags=list)(item)
        strings(item['tags'])


def tags(value):
    fields(id=str, tags=list)(value)
    strings(value['tags'])


def tree(value):
    fields(root=list)(value)
    seen = set()
    def visit(nodes, depth=0):
        records(nodes)
        if depth > 100:
            raise ValueError('Tree is too deep')
        for node in nodes:
            fields(id=str)(node)
            if node['id'] in seen:
                raise ValueError('Duplicate node id')
            seen.add(node['id'])
            if 'tags' in node:
                strings(node['tags'])
            if node.get('children') is not None:
                visit(node['children'], depth + 1)
    visit(value['root'])


def scope(value, modules):
    if value in modules or value in ('cms', 'photos', 'space'):
        return value
    if value.startswith('photos-') and re.fullmatch(r'[\w-]+', value[7:]):
        return value
    raise ValueError('Invalid module scope')
